# Smart Downloader Deploy

## Vercel

1. Open the Vercel deploy link from `README.md`.
2. Sign in with GitHub and import the repository.
3. Use the project name `smart-downloader` if it is available.
4. Deploy on the Hobby plan.
5. After deploy, open the Chrome extension and set `App address` to the Vercel URL if it differs from `https://smart-downloader.vercel.app`.

This no-card path uses Vercel serverless functions. It supports the Node-based captured-link and range download paths, but Docker-only tools such as ffmpeg, aria2c, yt-dlp, and Playwright are not available there.

## Local

```bash
npm install
npm start
```

Open `http://localhost:5177`.
