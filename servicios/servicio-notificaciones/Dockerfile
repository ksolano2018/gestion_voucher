FROM node:18-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . ./
EXPOSE 8083
CMD ["npm","start"]
