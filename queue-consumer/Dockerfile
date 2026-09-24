FROM golang:1.26-alpine AS builder

WORKDIR /src
COPY go/ship ./go/ship
COPY queue-consumer ./queue-consumer
WORKDIR /src/queue-consumer
RUN go mod download
RUN CGO_ENABLED=0 go build -o /queue-consumer .

FROM alpine:3.24
RUN apk add --no-cache ca-certificates
COPY --from=builder /queue-consumer /usr/local/bin/queue-consumer
ENTRYPOINT ["queue-consumer"]
