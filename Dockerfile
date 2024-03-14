# 使用官方Node.js v20.8.1镜像作为基础镜像
FROM node:20.8.1

# 设置工作目录
WORKDIR /app

# 复制package.json和package-lock.json（如果存在）到工作目录
COPY package*.json ./

# 安装依赖并清除缓存，减少镜像大小
RUN npm install && npm cache clean --force

# 复制项目文件到工作目录
COPY . .

# 使用非root用户运行你的应用，提高安全性
RUN adduser --disabled-password --gecos '' myuser
USER myuser

# 设置环境变量
ENV NODE_ENV=production \
    PORT=3000 \
    LOG_LEVEL=error \
    API_VERSION=2024-03-01-preview

# 公开容器运行时的端口
EXPOSE 3000

# 定义容器启动时执行的命令
CMD ["npm", "start"]
