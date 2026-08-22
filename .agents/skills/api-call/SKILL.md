---
name: api-call
description: Make API calls with authentication, retry logic, and response parsing
runtime: node
required_environment_variables:
  - API_BASE_URL
tags:
  - api
  - http
  - integration
parameters:
  - name: endpoint
    description: API endpoint path (e.g., /users, /posts)
    required: true
    type: string
  - name: method
    description: HTTP method (GET, POST, PUT, DELETE)
    required: false
    type: string
    default: GET
  - name: data
    description: JSON data for POST/PUT requests
    required: false
    type: string
  - name: headers
    description: Additional HTTP headers as JSON
    required: false
    type: string
---

# API Call Skill

Make API calls with authentication, retry logic, and response parsing. This skill demonstrates the execution engine's ability to run Node.js scripts.

## How It Works

1. Receives endpoint, method, and optional data/headers
2. Makes HTTP request to API_BASE_URL + endpoint
3. Handles authentication via API_KEY environment variable
4. Implements retry logic with exponential backoff
5. Returns structured response

## Usage

When the user needs to make an API call, execute this skill with the endpoint and method.

## Security

- API keys are injected via environment variables
- Base URL is configured via API_BASE_URL
- Retry logic prevents excessive requests
