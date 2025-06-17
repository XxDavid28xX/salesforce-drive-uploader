const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
require('dotenv').config();

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
 * 🔍 Busca una carpeta con nombre = parentId.
 * Si no existe, la crea dentro de FOLDER_ID raíz.
 */
async function getOrCreateCaseFolder(parentId) {
  const folderName = String(parentId).trim();

  // Busca si ya existe la carpeta
  const search = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${process.env.FOLDER_ID}' in parents and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive'
  });

  if (search.data.files.length > 0) {
    return search.data.files[0].id;
  }

  // Si no existe, crea la carpeta
  const folderMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [process.env.FOLDER_ID]
  };

  const folder = await drive.files.create({
    resource: folderMetadata,
    fields: 'id'
  });

  // Hace pública la carpeta
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

    await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id'
    });

    const folderUrl = `https://drive.google.com/drive/folders/${caseFolderId}`;
    res.json({ url: folderUrl });

  } catch (error) {
    console.error('❌ Error al subir:', error.message);
    res.status(500).send('Error al subir archivo');
  }
});

app.get('/', (req, res) => {
  res.send('✅ Middleware activo y escuchando');
});

app.listen(3000, () => {
  console.log('🚀 Servidor escuchando en puerto 3000');
});
