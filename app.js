import fetch from 'node-fetch';
import express from 'express';
import wiston from 'winston';
import { format } from 'winston';

import dotenv from 'dotenv';
dotenv.config();

const app = express();

const port = process.env.PORT || 3000;
const logLevel = process.env.LOG_LEVEL || 'info';
const apiVersion = process.env.API_VERSION || '2021-05-01';
const modelMap = {
    "gpt-3.5-turbo": "gpt-3.5-turbo-0125",
    "gpt-3.5-turbo-16k": "gpt-3.5-turbo-16k-0613",
    "gpt-4": "gpt-4-0613",
    "gpt-4-turbo-preview": "gpt-4-0125-preview",
    "gpt-4-32k": "gpt-4-32k-0613",
	"gpt-4-vision-preview": "gpt-4-1106-vision-preview"
}

// 增加请求体的大小限制
app.use(express.json({ limit: '50mb' }));  // JSON 请求体的大小限制
app.use(express.urlencoded({ limit: '50mb', extended: true }));  // URL编码的请求体的大小限制

// 定义日志格式
const logFormat = format.printf(info => {
    // 将时间戳转换为北京时间
    let time = new Date(info.timestamp).toLocaleString('zh-CN', { hour12: false });
    let message = `[${info.level}]: ${time} | ${typeof info.message === 'string' ? info.message : JSON.stringify(info.message, null, 2)}`;

    const splatArgs = info[Symbol.for('splat')]
    if (splatArgs) {
        message += ` ${splatArgs.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg, null, 2)).join(' ')}`;
    }
    return message;
});

// 创建一个日志记录器
const logger = wiston.createLogger({
    format: format.combine(
        format.colorize(),
        format.timestamp(),
        format.splat(),
        logFormat
    ),
    transports: [
        // 将日志输出到控制台
        new wiston.transports.Console()
    ],
    exitOnError: false
});

// 设置日志级别
logger.level = logLevel;

app.all('*', async (req, res) => {
    let reqPath = req.path;
    // 清除多余的斜杠, 例如 /v1//chat/completions// => /v1/chat/completions
    reqPath = reqPath.replace(/\/{2,}/g, '/');
    reqPath = reqPath.replace(/\/$/, '');
    const reqPathSegments = reqPath.split('/');
    logger.debug('Request Path:', reqPath);

    let region = reqPathSegments[1];
    if (region == 'v1') {
        return standerdError(res, 400, 404, 'not found', 'Region is not defined, you must provide a region name');
    }

    let deploymentName = reqPathSegments[2];
    if (deploymentName === 'v1') {
        return standerdError(res, 400, 404, 'not found', 'DeploymentName if not defined, you must provide a deployment name');
    }
    logger.debug('Deployment Name:', deploymentName);

    let switchPath = reqPathSegments.slice(3).join('/');
    logger.debug('Switch Path:', switchPath);

    let channelName = reqPathSegments[3];
    if (channelName !== 'v1') {
        switchPath = reqPathSegments.slice(4).join('/');
    } else {
        channelName = '';
    }

    logger.debug('Channel Name:', channelName);
    logger.debug('Switch Path:', switchPath);

    switch (switchPath) {
        case 'v1/chat/completions':
            await chatCompletions(req, res, region, deploymentName, channelName);
            break;
        case 'v1/image/generations':
            await imageGenerations(req, res, region, deploymentName, channelName);
            break;

        case 'v1/embeddings':
        case 'v1/engines/text-embedding-ada-002/embeddings':
            await embeddings(req, res, region, deploymentName, channelName);

        case 'v1/whisper/transcribe':
            await whisperTranscribe(req, res, region, deploymentName, channelName);
            break;

        default:
            return standerdError(res, 404, 404, 'path not found', 'The path you requested is not registered in the server');
    }
});

async function chatCompletions(req, res, region, deploymentName, channelName) {
    const reqBody = req.body;
    let reqHeaders = req.headers;
    let fetchUrl = `https://${region}.api.cognitive.microsoft.com/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`;

    // 检查请求头是否包含Authorization Bearer Token
    if (!reqHeaders.authorization) {
        return standerdError(res, 401, 401, 'unauthorized', 'You must provide an authorization token');
    }

    const authToken = reqHeaders.authorization.split(' ')[1];
    logger.debug('Authorization Token:', authToken);

    reqHeaders['api-key'] = authToken;
    delete reqHeaders.authorization;

    logger.debug('Request Headers:', reqHeaders);

    let model = reqBody?.model;

    if (!model) {
        return standerdError(res, 400, 400, 'model not defined', 'You must provide a model name');
    }

    let reqMethod = req.method;

    logger.debug('Request Method:', reqMethod);

    logger.debug('Fetch URL:', fetchUrl);
    logger.debug('Request Body:', reqBody);
    logger.debug('Request Headers type:', typeof reqHeaders);

    try {
        const response = await fetch(fetchUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'api-key': authToken
            },
            body: typeof reqBody === 'object' ? JSON.stringify(reqBody) : '{}' // 如果请求体不是对象，则传入空对象
        });

        if (response.ok) {
            if (reqBody?.stream) {
                logger.debug('type of response.body:', typeof response.body);
                logger.debug('response.headers:', response.headers);
                let resHeaders = response.headers;
                resHeaders['Content-Type'] = 'text/event-stream';
                res.writeHead(response.status, resHeaders);
                streamModifier(response.body, res, model);
            } else {
                const data = await response.json();
                res.writeHead(response.status, response.headers);
                data.model = model;
                res.write(JSON.stringify(data));
                res.end();
            }
        } else {
            handelFetchError(res, response, region, deploymentName, channelName);
        }
    } catch (error) {
        logger.error(`get error in chatCompletions: ${error}`);
        return standerdError(res, 500, 500, 'internal server error', 'An error occurred while processing your request');
    }
}

async function streamModifier(resBody, res, model) {
    try {
        let buffer = '';
        resBody.on('data', (data) => {
            logger.debug('stream data');
            if(!data) return;
            let content = data.toString();
            content += buffer;
            let lines = content.split('\n');
            buffer = content.endsWith('\n') ? '' : lines.pop();// 如果最后一个字符不是换行符，则将其保存到buffer中
            lines.forEach(line => {
                try{
                    let newLine = makeLine(line, model);
                    res.write(newLine);
                    logger.debug('newLine:', newLine);
                }catch(e){
                    // 如果发生解析错误，则记录错误日志
                    if(e instanceof SyntaxError){
                        logger.error('meet a syntax error:', e);
                        logger.error('line:', line);
                        logger.error('buffer:', buffer);
                    }else{
                        logger.error('meet an error:', e);
                    }
                }
            });
        });
        resBody.on('end', () => {
            if (buffer) {
                let newLine = makeLine(buffer, model);
                res.write(newLine);
            }
            res.end();
            logger.debug('stream ended');
        });
    } catch (error) {
        logger.error(`get error in streamModifier: ${error}`);
        return standerdError(res, 500, 500, 'internal server error', 'An error occurred while processing your request');
    }
}

function makeLine(line, model) {
    if (line === 'data: [DONE]') {
        logger.debug('meet [DONE]');
        return 'data: [DONE]\n\n';
    } else if (line.startsWith('data: ')) {
        // 获取json数据
        let json = JSON.parse(line.slice(6));
        json.model = modelMap[model] || model;
        return `data: ${JSON.stringify(json)}\n\n`;
    }
    return '';
}

async function imageGenerations(req, res, region, deploymentName, channelName) {
    const fetchUrl = `https://${region}.api.cognitive.microsoft.com/openai/deployments/${deploymentName}/image/generations?api-version=${apiVersion}`;
    others(req, res, region, deploymentName, channelName, fetchUrl);
}

async function embeddings(req, res, region, deploymentName, channelName) {
    const fetchUrl = `https://${region}.api.cognitive.microsoft.com/openai/deployments/${deploymentName}/embeddings?api-version=${apiVersion}`;
    others(req, res, region, deploymentName, channelName, fetchUrl);
}

async function whisperTranscribe(req, res, region, deploymentName, channelName) {
    const fetchUrl = `https://${region}.api.cognitive.microsoft.com/openai/deployments/${deploymentName}/whisper/transcribe?api-version=${apiVersion}`;
    others(req, res, region, deploymentName, channelName, fetchUrl);
}

async function standerdError(res, resCode, errorCode, message, description = '') {
    res.writeHead(resCode, { 'Content-Type': 'application/json' });
    res.write(JSON.stringify({
        error: {
            code: errorCode,
            message: message,
            description: description
        }
    }));
    res.end();
    return;
}

async function handelFetchError(res, response, region, deploymentName, channelName) {
    logger.error(`Failed to request channel name '${channelName}' in deployment '${deploymentName}' in region '${region}' with status code ${response.status}, status text: ${response.statusText}, and response body: '${await response.text()}'`);
    res.writeHead(response.status, response.headers);
    res.write(JSON.stringify({ error: true, code: response.status, message: 'meet an error' }));
    res.end();
    return;
}

async function others(req, res, region, deploymentName, channelName, fetchUrl) {
    const reqBody = req.body;
    const reqHeaders = req.headers;
    const reqMethod = req.method;

    // 检查请求头是否包含Authorization Bearer Token
    if (!reqHeaders.authorization) {
        return standerdError(res, 401, 401, 'unauthorized', 'You must provide an authorization token');
    }

    const authToken = reqHeaders.authorization.split(' ')[1];
    logger.debug('Authorization Token:', authToken);

    reqHeaders['api-key'] = authToken;
    delete reqHeaders.authorization;

    logger.debug('Request Headers:', reqHeaders);

    let response = await fetch(fetchUrl, {
        method: reqMethod,
        headers: reqHeaders,
        body: typeof reqBody === 'object' ? JSON.stringify(reqBody) : null
    });
    
    if (response.ok) {
        let headers = response.headers;
        headers['Content-Type'] = 'application/json';
        res.writeHead(response.status, headers);
        res.pipe(response.body);
        return;
    }else{
        handelFetchError(res, response, region, deploymentName, channelName);
    }
}

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

// 监听未捕获的异常
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
});

// 监听未捕获的拒绝
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// 监听进程退出
process.on('exit', (code) => {
    console.log(`Process exit with code: ${code}`);
});

// 监听进程关闭
process.on('SIGINT', () => {
    console.log('Process received SIGINT signal');
    process.exit(0);
});