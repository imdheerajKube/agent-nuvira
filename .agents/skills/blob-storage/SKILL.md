---
name: blob-storage
description: Set up blob/file storage: S3, Cloudflare R2, or Azure Blob for uploads, assets, and backups. Use when the goal asks to add file uploads, cloud storage, or asset hosting.
version: 1.0.0
---

# blob-storage

Set up blob/file storage: S3, Cloudflare R2, or Azure Blob for uploads, assets, and backups. Use when the goal asks to add file uploads, cloud storage, or asset hosting.

## Goal pattern

blob storage s3 cloudflare r2 azure upload file asset hosting bucket

## Parameters

- provider (choice [default: auto]): Storage provider

## Steps

1. [analyst] Choose the storage provider: S3, R2, Azure Blob, or MinIO. Set up the bucket/container with appropriate permissions.

2. [analyst] Implement upload: create presigned URLs for client-side upload, or server-side upload with streaming. (after: step-0)

3. [analyst] Add access control: implement signed URLs for read, bucket policies for public assets, and ACL for private files. (after: step-1)

4. [analyst] Handle processing: add image resizing on upload, virus scanning, and metadata extraction. (after: step-2)

5. [analyst] Test and optimize: verify uploads work, test file serving, add CDN caching, and monitor storage costs. (after: step-3)
