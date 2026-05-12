FROM node:20-alpine

# 创建应用目录
WORKDIR /usr/src/app

# 安装应用依赖
# 使用通配符确保 package.json 和 package-lock.json 都被复制
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制应用程序代码
COPY . .

# 创建应用运行目录
RUN mkdir -p /usr/src/app/tmp && \
    chmod -R 777 /usr/src/app/tmp

# 暴露端口
EXPOSE 8888

# 设置环境变量
ENV NODE_ENV=production \
    PORT=8888

# 启动应用
CMD ["node", "server.js"]
