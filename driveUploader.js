const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
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

/**
 * 🔍 Busca una carpeta con nombre = parentId (ej. Id del caso).
 * Si no existe, la crea dentro de la carpeta raíz (FOLDER_ID).
 */
async function getOrCreateCaseFolder(parentId) {
  const folderName = String(parentId).trim();

  const search = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${process.env.FOLDER_ID}' in parents and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive'
  });

  if (search.data.files.length > 0) {
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

  return folder.data.id;
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
      fields: 'id'
    });

    // Elimina el archivo temporal de la carpeta uploads/
    fs.unlink(req.file.path, (err) => {
      if (err) console.error('⚠️ No se pudo eliminar archivo temporal:', err.message);
    });

    const folderUrl = `https://drive.google.com/drive/folders/${caseFolderId}`;
    res.json({ url: folderUrl });

  } catch (error) {
    console.error('❌ Error al subir:', error.message);
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

      const sfRes = await fetch(sfUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      if (!sfRes.ok) {
        return res.status(sfRes.status).json({ error: 'Falla al descargar archivo desde Salesforce' });
      }

      const buffer = await sfRes.buffer();
      const mimeType = sfRes.headers.get('content-type');
      const ext = require('mime-types').extension(mimeType);
      const fileName = `${fileId}.${ext}`;

      const caseFolderId = await getOrCreateCaseFolder(caseNumber);

      const uploaded = await drive.files.create({
        resource: {
          name: fileName,
          parents: [caseFolderId]
        },
        media: {
          mimeType,
          body: Buffer.from(buffer)
        },
        fields: 'webViewLink'
      });

      res.json({ url: uploaded.data.webViewLink });
    });

  } catch (err) {
    console.error('❌ Error en uploadFromSalesforce:', err.message);
    res.status(500).json({ error: 'Error en middleware al subir archivo grande' });
  }
});

app.get('/', (req, res) => {
  res.send('✅ Middleware activo y escuchando');
});

app.listen(3000, () => {
  console.log('🚀 Servidor escuchando en puerto 3000');
});
