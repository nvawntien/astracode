FROM ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -qy --no-install-recommends \
        cloud-init=26.2-0ubuntu1~24.04.2 systemd=255.4-1ubuntu8.19 nftables=1.0.9-1ubuntu0.1 \
    && rm -rf /var/lib/apt/lists/*
