#!/bin/bash

# 设置环境变量
export NODE_ENV=production
export AUTH_ENABLED=true
export AUTH_PASSWORD=qq778899

# 创建会话目录并设置权限
mkdir -p sessions
chmod 777 sessions

# 启动应用
node --max-old-space-size=1024 server.js
