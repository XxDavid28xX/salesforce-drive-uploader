const { Readable } = require('stream');
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const mime = require('mime-types');
const path = require('path');
require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json({ limit: '50mb' })); // Soporta payloads grandes

// Autenticación con Google OAuth2
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// Función de reintento con logs extendidos
async function withRetries(fn, retries = 3, delay = 1000, label = 'Operación') {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🔁 [${label}] Intento ${attempt}...`);
      const result = await fn();
      console.log(`✅ [${label}] Éxito en intento ${attempt}`);
      return result;
    } catch (err) {
      console.warn(`⚠️ [${label}] Intento ${attempt} fallido: ${err.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, delay * attempt));
      else throw new Error(`[${label}] Falló tras ${retries} intentos: ${err.message}`);
    }
  }
}

// Crear carpeta para el caso (sin buscar, solo crea)
async function createCaseFolder(parentId) {
  const folderName = String(parentId).trim();
  try {
    console.log(`📁 Creando nueva carpeta para caso: ${folderName}`);
    const folder = await drive.files.create({
      resource: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [process.env.FOLDER_ID]
      },
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
    console.error(`❌ Error creando carpeta para caso ${parentId}:`, error.message);
    throw error;
  }
}

// Genera archivo CSV con los casos procesados
function generarCSVProcesados(okList, failList) {
  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const csvPath = path.join(__dirname, `upload-summary-${now}.csv`);
  const lines = [
    'CaseNumber,Status',
    ...okList.map(num => `"${num}",OK`),
    ...failList.map(num => `"${num}",ERROR`)
  ];
  fs.writeFileSync(csvPath, lines.join('\n'));
  return csvPath;
}

// Endpoint para subida desde formulario (no cambia, carpeta se crea siempre para un solo archivo)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    console.log('📨 Nueva solicitud POST /upload recibida');
    const parentId = req.body.parentId;
    if (!parentId) {
      console.warn('⚠️ parentId no proporcionado en el cuerpo de la petición');
      return res.status(400).json({ error: 'parentId requerido' });
    }

    const caseFolderId = await createCaseFolder(parentId);

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
        console.error('🗑️ Error al eliminar archivo temporal:', err.message);
      } else {
        console.log(`🧹 Archivo temporal eliminado: ${req.file.path}`);
      }
    });

    const folderUrl = `https://drive.google.com/drive/folders/${caseFolderId}`;
    console.log(`✅ Archivo ${req.file.originalname} subido correctamente. Carpeta: ${folderUrl}`);
    res.json({ url: folderUrl });

  } catch (error) {
    console.error('❌ Error en POST /upload:', error.message);
    res.status(500).json({
      error: 'Falló la subida del archivo',
      detalle: error.message,
      fileId: req.body?.fileId,
      caseNumber: req.body?.caseNumber
    });
  }
});

// Endpoint para Salesforce - Recibe varios archivos de un caso
app.post('/uploadFromSalesforce', async (req, res) => {
  try {
    console.log('📨 Nueva solicitud POST /uploadFromSalesforce recibida');
    // Espera: { caseNumber, accessToken, files: [{ fileId, type }] }
    let data = '';
    req.on('data', chunk => { data += chunk; });

    req.on('end', async () => {
      console.log(`🧾 Payload recibido: ${data}`);
      const { caseNumber, accessToken, files } = JSON.parse(data);

      if (!caseNumber || !accessToken || !Array.isArray(files)) {
        console.warn('⚠️ Parámetros faltantes en payload');
        return res.status(400).json({ error: 'Faltan parámetros requeridos (caseNumber, accessToken, files)' });
      }

      let todosOk = true;
      let archivosOk = [];
      let archivosFail = [];

      // 1. Intenta descargar todos los archivos
      let fileDatas = [];
      for (let file of files) {
        try {
          const sfUrl = file.type === 'attachment'
            ? `${process.env.SF_INSTANCE_URL}/services/data/v64.0/sobjects/Attachment/${file.fileId}/Body`
            : `${process.env.SF_INSTANCE_URL}/services/data/v64.0/sobjects/ContentVersion/${file.fileId}/VersionData`;

          console.log(`🔗 Descargando archivo desde Salesforce: ${sfUrl}`);

          const sfRes = await withRetries(() =>
            fetch(sfUrl, {
              method: 'GET',
              headers: { Authorization: `Bearer ${accessToken}` }
            }).then(async response => {
              if (!response.ok) throw new Error(`Salesforce respondió con ${response.status}`);
              const arrayBuffer = await response.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              return { buffer, mimeType: response.headers.get('content-type'), fileId: file.fileId, type: file.type };
            }), 3, 1000, `Descarga Salesforce (${file.fileId})`
          );
          fileDatas.push(sfRes);
          archivosOk.push(file.fileId);
        } catch (err) {
          todosOk = false;
          archivosFail.push(file.fileId);
          console.error(`❌ Error al descargar archivo ${file.fileId}:`, err.message);
        }
      }

      // 2. Si todos se descargaron bien, crea la carpeta y sube todo
      let caseFolderId = null;
      let uploadResults = [];
      if (todosOk && fileDatas.length > 0) {
        caseFolderId = await createCaseFolder(caseNumber);

        for (let f of fileDatas) {
          try {
            const ext = mime.extension(f.mimeType) || 'bin';
            const fileName = `${f.fileId}.${ext}`;
            console.log(`📁 Subiendo a Drive como ${fileName}...`);
            const uploaded = await withRetries(() =>
              drive.files.create({
                resource: {
                  name: fileName,
                  parents: [caseFolderId]
                },
                media: {
                  mimeType: f.mimeType,
                  body: Readable.from(f.buffer)
                },
                fields: 'id, webViewLink'
              }), 3, 1000, `Subida Google Drive (${fileName})`
            );
            uploadResults.push({ fileId: f.fileId, status: 'OK', driveId: uploaded.data.id, link: uploaded.data.webViewLink });
            console.log(`✅ Archivo ${fileName} subido a Drive correctamente`);
          } catch (err) {
            todosOk = false;
            archivosFail.push(f.fileId);
            uploadResults.push({ fileId: f.fileId, status: 'ERROR', error: err.message });
            console.error(`❌ Error al subir archivo ${f.fileId} a Drive:`, err.message);
          }
        }
      } else {
        console.warn('⚠️ No se creará la carpeta porque uno o más archivos fallaron al descargarse');
      }

      // 3. Generar archivo CSV de resultados (si hay algún archivo ok o fail)
      let csvPath = null;
      if (archivosOk.length > 0 || archivosFail.length > 0) {
        csvPath = generarCSVProcesados(archivosOk, archivosFail);
        console.log(`📋 Resumen de archivos generado: ${csvPath}`);
      }

      res.json({
        folderCreated: !!caseFolderId,
        driveFolderId: caseFolderId,
        uploadResults,
        summaryCsv: csvPath ? path.basename(csvPath) : null,
        archivosOk,
        archivosFail
      });
    });

  } catch (err) {
    console.error('❌ Error general en /uploadFromSalesforce:', err.message);
    res.status(500).json({ error: 'Error al subir archivos desde Salesforce', detalle: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('✅ Middleware activo y escuchando');
});

app.listen(3000, () => {
  console.log('🚀 Servidor escuchando en puerto 3000');
});
