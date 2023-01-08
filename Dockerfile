FROM node:18-alpine



# # Add user so we don't need --no-sandbox.
# RUN addgroup -S pptruser && adduser -S -G pptruser pptruser \
#   && mkdir -p /home/pptruser/Downloads /app \
#   && chown -R pptruser:pptruser /home/pptruser \
#   && chown -R pptruser:pptruser /app

# # Run everything after as non-privileged user.
# USER pptruser

WORKDIR /app

ADD . /app

RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont

RUN npm install -g pnpm
RUN pnpm install
RUN pnpm run build

CMD pnpm start

