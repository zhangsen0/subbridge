# SubBridge 常用开发/运维命令

.PHONY: install start dev check test docker-build docker-run

## 安装依赖
install:
	npm install

## 启动服务
start:
	node app.js

## 开发模式（文件变更自动重启）
dev:
	npm run dev

## 全套检查：语法检查 + 单元测试（提交前必须运行）
check:
	npm run check

## 仅运行单元测试
test:
	npm test

## 构建 Docker 镜像
docker-build:
	docker build -t subbridge .

## 以 Docker 运行（挂载 data 目录持久化运行时配置）
docker-run:
	docker run --rm -p 8080:8080 -v $$(pwd)/data:/app/data subbridge
