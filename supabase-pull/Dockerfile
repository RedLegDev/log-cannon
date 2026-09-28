FROM golang:1.26-alpine AS builder

WORKDIR /src
COPY go/ship ./go/ship
COPY supabase-pull ./supabase-pull
WORKDIR /src/supabase-pull
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -o /supabase-pull .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /supabase-pull .
CMD ["./supabase-pull"]
