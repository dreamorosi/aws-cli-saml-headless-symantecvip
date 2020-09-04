FROM buildkite/puppeteer:latest

COPY . /home/node/
RUN  cd /home/node/ && npm install --only=prod
ENV  PATH="${PATH}:/node_modules/.bin"

CMD AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy node /home/node/src/index.js