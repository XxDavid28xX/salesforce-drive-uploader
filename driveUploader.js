async function withRetries(fn, retries = 3, delay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`⚠️ Intento ${attempt} fallido: ${err.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, delay * attempt));
      else throw err;
    }
  }
}

const { Readable } = require('stream');
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const mime = require('mime-types');
require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const app = express();
const upload = multer({ dest: 'uploads/' });

const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);

oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

async function getOrCreateCaseFolder(parentId) {
  const folderName = String(parentId).trim();

  try {
    const search = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${process.env.FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });

    if (search.data.files.length > 0) {
      console.log(`📂 Carpeta encontrada para caso ${parentId}: ${search.data.files[0].id}`);
      return search.data.files[0].id;
    }

    const folderMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [process.env.FOLDER_ID]
    };

    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id'
    });

    await drive.permissions.create({
      fileId: folder.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });

    console.log(`🆕 Carpeta creada para caso ${parentId}: ${folder.data.id}`);
    return folder.data.id;
  } catch (error) {
    console.error(`❌ Error creando/obteniendo carpeta para caso ${parentId}:`, error.message);
    throw error;
  }
}

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const parentId = req.body.parentId;
    if (!parentId) {
      return res.status(400).json({ error: 'parentId requerido' });
    }

    const caseFolderId = await getOrCreateCaseFolder(parentId);

    const fileMetadata = {
      name: req.file.originalname,
      parents: [caseFolderId]
    };

    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(req.file.path)
    };

    const uploaded = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, webViewLink'
    });

    fs.unlink(req.file.path, (err) => {
      if (err) {
        console.error('⚠️ No se pudo eliminar archivo temporal:', err.message);
      } else {
        console.log(`🧹 Archivo temporal eliminado: ${req.file.path}`);
      }
    });

    const folderUrl = `https://drive.google.com/drive/folders/${caseFolderId}`;
    console.log(`✅ Archivo ${req.file.originalname} subido correctamente. Ver carpeta: ${folderUrl}`);
    res.json({ url: folderUrl });

  } catch (error) {
    console.error('❌ Error al subir archivo desde formulario:', error.message);
    res.status(500).send('Error al subir archivo');
  }
});

app.post('/uploadFromSalesforce', async (req, res) => {
  try {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', async () => {
      const { fileId, type, caseNumber, accessToken } = JSON.parse(data);

      if (!fileId || !type || !caseNumber || !accessToken) {
        return res.status(400).json({ error: 'Faltan parámetros requeridos' });
      }

      const sfUrl = type === 'attachment'
        ? `${process.env.SF_INSTANCE_URL}/services/data/v64.0/sobjects/Attachment/${fileId}/Body`
        : `${process.env.SF_INSTANCE_URL}/services/data/v64.0/sobjects/ContentVersion/${fileId}/VersionData`;

      const sfRes = await withRetries(() =>
        fetch(sfUrl, {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` }
        }).then(async response => {
          if (!response.ok) throw new Error(`Salesforce respondió con ${response.status}`);
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          return { buffer, mimeType: response.headers.get('content-type') };
        })
      );

      const ext = mime.extension(sfRes.mimeType) || 'bin';
      const fileName = `${fileId}.${ext}`;
      const caseFolderId = await getOrCreateCaseFolder(caseNumber);

      const uploaded = await withRetries(() =>
        drive.files.create({
          resource: {
            name: fileName,
            parents: [caseFolderId]
          },
          media: {
            mimeType: sfRes.mimeType,
            body: Readable.from(sfRes.buffer)
          },
          fields: 'id, webViewLink'
        })
      );

      console.log(`✅ Archivo ${fileName} del caso ${caseNumber} subido exitosamente.`);
      res.json({ url: uploaded.data.webViewLink });
    });

  } catch (err) {
    console.error('❌ Error general en /uploadFromSalesforce:', err.message);
    res.status(500).json({ error: 'Error al subir archivo desde Salesforce' });
  }
});

app.get('/', (req, res) => {
  res.send('✅ Middleware activo y escuchando');
});

app.listen(3000, () => {
  console.log('🚀 Servidor escuchando en puerto 3000');
});
