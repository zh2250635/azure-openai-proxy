import fetch from "node-fetch";
import express, { json } from "express";
import wiston from "winston";
import { format } from "winston";

import dotenv from "dotenv";
dotenv.config();

const app = express();

const port = process.env.PORT || 3000;
const logLevel = process.env.LOG_LEVEL || "info";
const apiVersion = process.env.API_VERSION || "2021-05-01";
const sleepTime = process.env.SLEEP_TIME || 100;
const modelMap = {
  "gpt-3.5-turbo": "gpt-3.5-turbo-0125",
  "gpt-3.5-turbo-16k": "gpt-3.5-turbo-16k-0613",
  "gpt-4": "gpt-4-0613",
  "gpt-4-turbo-preview": "gpt-4-0125-preview",
  "gpt-4-32k": "gpt-4-32k-0613",
  "gpt-4-vision-preview": "gpt-4-1106-vision-preview",
};

// 增加请求体的大小限制
app.use(express.json({ limit: "50mb" })); // JSON 请求体的大小限制
app.use(express.urlencoded({ limit: "50mb", extended: true })); // URL编码的请求体的大小限制

// 定义日志格式
const logFormat = format.printf((info) => {
  // 将时间戳转换为北京时间
  let time = new Date(info.timestamp).toLocaleString("zh-CN", {
    hour12: false,
  });
  let message = `[${info.level}]: ${time} | ${
    typeof info.message === "string"
      ? info.message
      : JSON.stringify(info.message, null, 2)
  }`;

  const splatArgs = info[Symbol.for("splat")];
  if (splatArgs) {
    message += ` ${splatArgs
      .map((arg) =>
        typeof arg === "string" ? arg : JSON.stringify(arg, null, 2)
      )
      .join(" ")}`;
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
    new wiston.transports.Console(),
  ],
  exitOnError: false,
});

// 设置日志级别
logger.level = logLevel;

// 构造一个中间件，用于记录请求信息和消耗的时间
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    logger.info(
      `使用 ${req.method} 方法，请求了 ${req.path} 路径，响应状态码为 ${res.statusCode}，消耗了 ${ms} ms`
    );
  });
  next();
});

app.all("*", async (req, res) => {
  let reqPath = req.path;
  // 清除多余的斜杠, 例如 /v1//chat/completions// => /v1/chat/completions
  reqPath = reqPath.replace(/\/{2,}/g, "/");
  reqPath = reqPath.replace(/\/$/, "");
  const reqPathSegments = reqPath.split("/");
  logger.debug("Request Path:", reqPath);

  let region = reqPathSegments[1];
  if (region == "v1") {
    return standerdError(
      res,
      400,
      404,
      "not found",
      "Region is not defined, you must provide a region name"
    );
  }

  let deploymentName = reqPathSegments[2];
  if (deploymentName === "v1") {
    return standerdError(
      res,
      400,
      404,
      "not found",
      "DeploymentName if not defined, you must provide a deployment name"
    );
  }
  logger.debug("Deployment Name:", deploymentName);

  let switchPath = reqPathSegments.slice(3).join("/");
  logger.debug("Switch Path:", switchPath);

  let channelName = reqPathSegments[3];
  if (channelName !== "v1") {
    switchPath = reqPathSegments.slice(4).join("/");
  } else {
    channelName = "";
  }

  logger.debug("Channel Name:", channelName);
  logger.debug("Switch Path:", switchPath);

  switch (switchPath) {
    case "v1/chat/completions":
      await chatCompletions(req, res, region, deploymentName, channelName);
      break;
    case "v1/images/generations":
      await imageGenerations(req, res, region, deploymentName, channelName);
      break;

    case "v1/embeddings":
    case "v1/engines/text-embedding-ada-002/embeddings":
      await embeddings(req, res, region, deploymentName, channelName);
      break;

    case "v1/whisper/transcribe":
      await whisperTranscribe(req, res, region, deploymentName, channelName);
      break;

    default:
      return standerdError(
        res,
        404,
        404,
        "path not found",
        "The path you requested is not registered in the server"
      );
  }
});

async function chatCompletions(req, res, region, deploymentName, channelName) {
  try {
    const reqBody = req.body;
    let reqHeaders = req.headers;
    let fetchUrl = `https://${region}.api.cognitive.microsoft.com/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`;

    // 检查请求头是否包含Authorization Bearer Token
    if (!reqHeaders.authorization) {
      return standerdError(
        res,
        401,
        401,
        "unauthorized",
        "You must provide an authorization token"
      );
    }

    const authToken = reqHeaders.authorization.split(" ")[1];
    logger.debug("Authorization Token:", authToken);

    reqHeaders["api-key"] = authToken;
    delete reqHeaders.authorization;

    logger.debug("Request Headers:", reqHeaders);

    let model = reqBody?.model;

    if (!model) {
      return standerdError(
        res,
        400,
        400,
        "model not defined",
        "You must provide a model name"
      );
    }

    let reqMethod = req.method;

    logger.debug("Request Method:", reqMethod);

    logger.debug("Fetch URL:", fetchUrl);
    logger.debug("Request Body:", reqBody);
    logger.debug("Request Headers type:", typeof reqHeaders);

    const response = await fetch(fetchUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": authToken,
      },
      body: typeof reqBody === "object" ? JSON.stringify(reqBody) : "{}", // 如果请求体不是对象，则传入空对象
    });

    if (response.ok) {
      if (reqBody?.stream) {
        logger.debug("type of response.body:", typeof response.body);
        logger.debug("response.headers:", response.headers);
        let resHeaders = response.headers.raw();
        logger.debug("response.headers.raw():", resHeaders);
        resHeaders["Content-Type"] = "text/event-stream";
        if (!process.env.NOT_MODIFY_STREAM) {
          res.writeHead(response.status, resHeaders);
          streamModifier(response.body, res, model);
        }else{
          res.writeHead(response.status, resHeaders);
          response.body.pipe(res);
        }
      } else {
        const data = await response.json();
        // res.writeHead(response.status, response.headers.raw());
        data.model = modelMap[model] || model;
        res.json(data);
        logger.debug("response data:", data);
        res.end();
      }
    } else {
      handelFetchError(res, response, region, deploymentName, channelName);
    }
  } catch (error) {
    logger.error(`get error in chatCompletions: ${error}`);
    return standerdError(
      res,
      500,
      500,
      "internal server error",
      "An error occurred while processing your request"
    );
  }
}

async function streamModifier(resBody, res, model) {
  try {
    let buffer = "";
    const streamRes = new StreamResponse(res);
    // 'data'事件处理器：当接收到新的数据块时触发
    resBody.on("data", (data) => {
      // 记录调试信息：表示开始接收数据流
      logger.debug("stream data");

      // 如果data是空的，就直接返回不做处理
      if (!data) return;

      // 将接收到的数据块转换为字符串形式
      let content = data.toString();

      // 将转换后的数据添加到buffer中，用于积累完整的数据
      buffer += content;

      // 查找buffer中最后一个出现的双换行符的位置，这用于区分完整的消息和不完整的消息
      let lastNewlineIndex = buffer.lastIndexOf("\n\n");

      // 将buffer中到最后一个双换行符之前的部分（如果有的话）视为完整数据
      let completeData = buffer.substring(0, lastNewlineIndex);

      // 将最后一个双换行符之后的部分保留为不完整的数据，等待更多的数据到来
      let incompleteData = buffer.substring(lastNewlineIndex + 2);

      // 更新buffer，只保存不完整的数据部分
      buffer = incompleteData;

      // 将完整的数据部分按双换行符分割，得到完整的消息行
      let lines = completeData.split("\n\n");

      // 遍历所有完整的消息行
      lines.forEach(async (line) => {
        // 对每一行使用makeLine函数进行处理，可能是格式化、过滤等
        let newLine = makeLine(line, model);

        // 如果处理后的行是有效的，则写入响应流
        if (newLine) {
          streamRes.addline(newLine);
        }

        // 记录调试信息：输出处理后的新行内容
        logger.debug("newLine:", newLine);
      });
    });

    resBody.on("end", () => {
      if (buffer) {
        let newLine = makeLine(buffer, model);
        streamRes.addline(newLine);
      }
      streamRes.responseStoped(true);
      logger.debug("stream ended");
    });
  } catch (error) {
    logger.error(`在streamModifier函数中捕捉到一个错误: ${error}`);
    return standerdError(
      res,
      500,
      500,
      "internal server error",
      "An error occurred while processing your request"
    );
  }
}

function makeLine(line, model) {
  if (line === "data: [DONE]") {
    logger.debug("meet [DONE]");
    return "data: [DONE]\n\n";
  } else if (line.startsWith("data: ")) {
    try {
      // 获取json数据
      let json = JSON.parse(line.slice(6));

      // 去除choices长度为0的情况
      if (json.choices.length === 0) {
        return "";
      }

      //   如果json数据中包含content_filter_results字段，则将该字段删除
      if (json?.content_filter_results) {
        delete json.content_filter_results;
        logger.debug("delete content_filter_results in json");
      }
      if (json?.choices?.[0]?.content_filter_result) {
        delete json.choices[0].content_filter_result;
        logger.debug("delete content_filter_result in json.choices[0]");
      }
      json.model = modelMap[model] || model;
      return `data: ${JSON.stringify(json)}\n\n`;
    } catch (error) {
      logger.error(`在构造数据时遇到错误: ${error}，发生错误的数据: ${line}`);
    }
  }
  return "";
}

async function imageGenerations(req, res, region, deploymentName, channelName) {
  const fetchUrl = `https://${region}.api.cognitive.microsoft.com/openai/deployments/${deploymentName}/images/generations?api-version=${apiVersion}`;
  others(req, res, region, deploymentName, channelName, fetchUrl);
}

async function embeddings(req, res, region, deploymentName, channelName) {
  const fetchUrl = `https://${region}.api.cognitive.microsoft.com/openai/deployments/${deploymentName}/embeddings?api-version=${apiVersion}`;
  others(req, res, region, deploymentName, channelName, fetchUrl);
}

async function whisperTranscribe(
  req,
  res,
  region,
  deploymentName,
  channelName
) {
  const fetchUrl = `https://${region}.api.cognitive.microsoft.com/openai/deployments/${deploymentName}/whisper/transcribe?api-version=${apiVersion}`;
  others(req, res, region, deploymentName, channelName, fetchUrl);
}

async function standerdError(
  res,
  resCode,
  errorCode,
  message,
  description = ""
) {
  res.writeHead(resCode, { "Content-Type": "application/json" });
  res.write(
    JSON.stringify({
      error: {
        code: errorCode,
        message: message,
        description: description,
      },
    })
  );
  res.end();
  return;
}

async function handelFetchError(
  res,
  response,
  region,
  deploymentName,
  channelName
) {
  logger.error(
    `Failed to request channel name '${channelName}' in deployment '${deploymentName}' in region '${region}' with status code ${
      response.status
    }, status text: ${
      response.statusText
    }, and response body: '${await response.text()}'`
  );
  let headers = response.headers.raw();
  headers["Content-Type"] = "application/json";
  res.writeHead(response.status, headers);
  res.write(
    JSON.stringify({
      error: {
        message: "meet a error",
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    })
  );
  res.end();
  return;
}

async function others(req, res, region, deploymentName, channelName, fetchUrl) {
  try {
    // logger.debug("others function", fetchUrl);
    const reqBody = req.body;
    const reqHeaders = req.headers;
    const reqMethod = req.method;

    // 检查请求头是否包含Authorization Bearer Token
    if (!reqHeaders.authorization) {
      return standerdError(
        res,
        401,
        401,
        "unauthorized",
        "You must provide an authorization token"
      );
    }

    const authToken = reqHeaders.authorization.split(" ")[1];
    logger.debug("Authorization Token:", authToken);

    reqHeaders["api-key"] = authToken;
    delete reqHeaders.authorization;

    logger.debug("Request Headers:", reqHeaders);

    const response = await fetch(fetchUrl, {
      method: reqMethod,
      headers: {
        "Content-Type": "application/json",
        "api-key": authToken,
      },
      body: typeof reqBody === "object" ? JSON.stringify(reqBody) : null,
    });

    if (response.ok) {
      let headers = response.headers;
      headers["Content-Type"] = "application/json";
      await res.writeHead(response.status, headers);
      response.body.pipe(res);
      return;
    } else {
      handelFetchError(res, response, region, deploymentName, channelName);
    }
  } catch (error) {
    logger.error(
      `在others函数中的请求发出前捕捉到一个错误: ${error}, 传入的数据为：${region}, ${deploymentName}, ${channelName}, ${fetchUrl}, 错误发生在：${error.stack}`
    );
    return standerdError(
      res,
      500,
      500,
      "internal server error",
      "An error occurred while processing your request"
    );
  }
}

async function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// 监听未捕获的异常
process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception:", err);
});

// 监听进程退出
process.on("exit", (code) => {
  console.log(`Process exit with code: ${code}`);
});

// 监听进程关闭
process.on("SIGINT", () => {
  console.log("Process received SIGINT signal");
  process.exit(0);
});

class StreamResponse {
  constructor(res) {
    this.res = res;
    this.queue = [];
    this.upperResponseFinished = false;

    this.write();
  }

  async write() {
    while (true) {
      if (this.queue.length === 0) {
        await sleep(100);
      } else {
        let data = this.queue.shift();
        this.res.write(data);
        if (data === "data: [DONE]\n\n") {
          this.end();
          break;
        }
        if (!this.upperResponseFinished) {
          await sleep(sleepTime);
        }
      }
    }
  }

  end() {
    this.res.end();
  }

  addline(line) {
    this.queue.push(line);
  }

  responseStoped(status) {
    this.upperResponseFinished = status;
  }
}
