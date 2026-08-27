#!/usr/bin/env python3
"""
Generate JWT token for testing.
Creates a signed JWT with configurable claims.
"""

import sys
import json
import time
import hashlib
import hmac
import base64
import argparse

def base64url_encode(data):
    """Encode data to base64url."""
    if isinstance(data, str):
        data = data.encode()
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()

def base64url_decode(data):
    """Decode base64url data."""
    data += '=' * (4 - len(data) % 4)
    return base64.urlsafe_b64decode(data)

def create_jwt(payload, secret, algorithm='HS256'):
    """Create a JWT token."""
    header = {
        "alg": algorithm,
        "typ": "JWT"
    }
    
    header_encoded = base64url_encode(json.dumps(header))
    payload_encoded = base64url_encode(json.dumps(payload))
    
    signature_input = f"{header_encoded}.{payload_encoded}"
    
    if algorithm == 'HS256':
        signature = hmac.new(
            secret.encode(),
            signature_input.encode(),
            hashlib.sha256
        ).digest()
    else:
        raise ValueError(f"Unsupported algorithm: {algorithm}")
    
    signature_encoded = base64url_encode(signature)
    
    return f"{header_encoded}.{payload_encoded}.{signature_encoded}"

def main():
    parser = argparse.ArgumentParser(description="Generate JWT token")
    parser.add_argument("--secret", "-s", default="test-secret", help="Secret key")
    parser.add_argument("--user-id", "-u", default="123", help="User ID")
    parser.add_argument("--role", "-r", default="user", help="User role")
    parser.add_argument("--expires", "-e", type=int, default=3600, help="Expiration in seconds")
    
    args = parser.parse_args()
    
    payload = {
        "sub": args.user_id,
        "role": args.role,
        "iat": int(time.time()),
        "exp": int(time.time()) + args.expires
    }
    
    token = create_jwt(payload, args.secret)
    
    print(f"Token: {token}")
    print(f"\nPayload: {json.dumps(payload, indent=2)}")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
