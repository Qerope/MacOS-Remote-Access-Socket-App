#!/bin/bash

# Stop and remove the container if it exists
docker stop macos-remote-service 2>/dev/null
docker rm macos-remote-service 2>/dev/null

# Rebuild the Docker image from the current directory
docker build -t macos-remote-service .

# Run the container with port mapping 80:3000
docker run -d --name macos-remote-service -p 80:3000 macos-remote-service
