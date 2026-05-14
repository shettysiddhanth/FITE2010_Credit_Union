FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y git bash && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
EXPOSE 8545 3000
