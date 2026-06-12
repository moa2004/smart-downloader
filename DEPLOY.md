# Smart Downloader Deploy

## Render

1. Push this folder to a Git repository.
2. Create a new Render Web Service from the repository.
3. Choose Docker as the environment.
4. Name the service `smart-downloader`.
5. Keep the exposed port as `5177`; the app also reads Render's `PORT` automatically.
6. After deploy, open the Chrome extension and change `App address` to your live URL.

This is the permanent deploy path. Temporary local tunnel links stop when the local machine stops.

## Local

```bash
npm install
npm start
```

Open `http://localhost:5177`.
