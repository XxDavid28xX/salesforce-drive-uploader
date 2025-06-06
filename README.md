# Salesforce Google Drive Uploader

Middleware para recibir archivos desde Salesforce y subirlos a Google Drive usando la API oficial.

## Endpoints

- `POST /upload`: Recibe un archivo (`multipart/form-data`) y lo sube a la carpeta de Google Drive especificada.

## Variables de entorno (`.env`)

- `CLIENT_ID`: ID del cliente OAuth2 de Google.
- `CLIENT_SECRET`: Secreto del cliente.
- `REDIRECT_URI`: Puede ser el Playground o uno propio.
- `REFRESH_TOKEN`: Token de actualización válido.
- `FOLDER_ID`: ID de la carpeta de destino en Google Drive.

## Cómo correrlo localmente

```bash
npm install
node driveUploader.js
