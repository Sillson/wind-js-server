FROM openjdk:19-slim-buster

RUN apt update && apt-get -y install nodejs npm

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 7000

CMD [ "node", "server.js" ]