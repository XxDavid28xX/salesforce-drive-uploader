const { Readable } = require('stream');
const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const fs = require('fs');
const mime = require('mime-types');
require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json({ limit: '50mb' })); // Por si mandas JSON grande de archivos
const upload = multer({ dest: 'uploads/' });

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

// Crear o buscar carpeta para el caso
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

// Subir un buffer a Google Drive como archivo
async function subirArchivoBufferDrive(buffer, folderId, fileName, mimeType = 'text/csv') {
  console.log(`📤 Subiendo archivo ${fileName} a carpeta ${folderId}`);
  const fileMetadata = {
    name: fileName,
    parents: [folderId]
  };
  const media = {
    mimeType,
    body: Readable.from(buffer)
  };
  const uploaded = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id, webViewLink'
  });
  console.log(`✅ Archivo log ${fileName} subido a ${uploaded.data.webViewLink}`);
  return uploaded;
}

// Generar un archivo CSV a partir de resultados
function generarCSV(resultados) {
  const encabezado = 'fileName,caseNumber,status,error\n';
  const filas = resultados.map(r =>
    `${r.fileName},${r.caseNumber},${r.status},"${r.error ? r.error.replace(/"/g, '""') : ''}"`
  ).join('\n');
  return encabezado + filas;
}

// Endpoint para subir lote de archivos de un caso
app.post('/uploadFromSalesforceLote', async (req, res) => {
  try {
    console.log('📨 Nueva solicitud POST /uploadFromSalesforceLote recibida');
    const { files, caseNumber, accessToken } = req.body;

    if (!files || !Array.isArray(files) || files.length === 0 || !caseNumber || !accessToken) {
      console.warn('⚠️ Payload inválido: falta files, caseNumber o accessToken');
      return res.status(400).json({ error: 'Payload inválido, se requiere files, caseNumber y accessToken' });
    }

    const resultados = [];

    // Intentar descargar y validar todos los archivos antes de crear carpeta
    for (const file of files) {
      const { fileId, type } = file;
      if (!fileId || !type) {
        resultados.push({
          fileName: fileId || 'UNKNOWN',
          caseNumber,
          status: 'FAIL',
          error: 'Faltan datos fileId o type'
        });
        continue;
      }

      try {
        const sfUrl = type === 'attachment'
          ? `${process.env.SF_INSTANCE_URL}/services/data/v64.0/sobjects/Attachment/${fileId}/Body`
          : `${process.env.SF_INSTANCE_URL}/services/data/v64.0/sobjects/ContentVersion/${fileId}/VersionData`;

        console.log(`🔗 Descargando archivo ${fileId} desde Salesforce: ${sfUrl}`);
        const sfRes = await withRetries(() =>
          fetch(sfUrl, {
            method: 'GET',
            headers: { Authorization: `Bearer ${accessToken}` }
          }).then(async response => {
            if (!response.ok) throw new Error(`Salesforce respondió con ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            return { buffer, mimeType: response.headers.get('content-type') };
          }), 3, 1000, `Descarga Salesforce ${fileId}`
        );

        file.buffer = sfRes.buffer;
        file.mimeType = sfRes.mimeType;
        file.fileName = `${fileId}.${mime.extension(sfRes.mimeType) || 'bin'}`;
        file.status = 'SUCCESS';
        resultados.push({
          fileName: file.fileName,
          caseNumber,
          status: 'SUCCESS',
          error: null
        });
      } catch (e) {
        resultados.push({
          fileName: fileId,
          caseNumber,
          status: 'FAIL',
          error: e.message
        });
        file.status = 'FAIL';
        file.error = e.message;
      }
    }

    // Si todos éxito, creas la carpeta y subes todos
    const todosExito = resultados.every(r => r.status === 'SUCCESS');
    let logDriveLink = null;

    if (todosExito) {
      const folderId = await createCaseFolder(caseNumber);
      for (const file of files) {
        try {
          console.log(`📁 Subiendo ${file.fileName} a Drive...`);
          await withRetries(() =>
            drive.files.create({
              resource: {
                name: file.fileName,
                parents: [folderId]
              },
              media: {
                mimeType: file.mimeType,
                body: Readable.from(file.buffer)
              },
              fields: 'id, webViewLink'
            }), 3, 1000, `Subida Google Drive ${file.fileName}`
          );
        } catch (e) {
          console.error(`❌ Error subiendo ${file.fileName} después de la carpeta creada:`, e.message);
        }
      }
      // Subir log a la misma carpeta
      const csv = generarCSV(resultados);
      const uploaded = await subirArchivoBufferDrive(Buffer.from(csv, 'utf-8'), folderId, `log_${caseNumber}.csv`);
      logDriveLink = uploaded.data.webViewLink;
      res.json({
        status: 'OK',
        folderId,
        logFile: logDriveLink,
        resultados
      });
    } else {
      // Subir CSV a una carpeta de errores, si quieres
      const erroresFolder = process.env.ERRORES_FOLDER_ID;
      const csv = generarCSV(resultados);
      if (erroresFolder) {
        const uploaded = await subirArchivoBufferDrive(Buffer.from(csv, 'utf-8'), erroresFolder, `error_${caseNumber}.csv`);
        logDriveLink = uploaded.data.webViewLink;
      }
      res.status(207).json({
        status: 'INCOMPLETE',
        folderId: null,
        logFile: logDriveLink,
        resultados
      });
    }

  } catch (err) {
    console.error('❌ Error general en /uploadFromSalesforceLote:', err.message);
    res.status(500).json({ error: 'Error en batch de subida de archivos', detalle: err.message });
  }
});

// Otros endpoints (uno a uno o formulario) SIN cambios, solo logs y legacy
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

// Endpoint legacy uno a uno (no soporta lógica de lote ni CSV)
app.post('/uploadFromSalesforce', async (req, res) => {
  try {
    console.log('📨 Nueva solicitud POST /uploadFromSalesforce recibida');
    let data = '';
    req.on('data', chunk => { data += chunk; });

    req.on('end', async () => {
      console.log(`🧾 Payload recibido: ${data}`);
      const { fileId, type, caseNumber, accessToken } = JSON.parse(data);

      if (!fileId || !type || !caseNumber || !accessToken) {
        console.warn('⚠️ Parámetros faltantes en payload');
        return res.status(400).json({ error: 'Faltan parámetros requeridos' });
      }

      const sfUrl = type === 'attachment'
        ? `${process.env.SF_INSTANCE_URL}/services/data/v64.0/sobjects/Attachment/${fileId}/Body`
        : `${process.env.SF_INSTANCE_URL}/services/data/v64.0/sobjects/ContentVersion/${fileId}/VersionData`;

      console.log(`🔗 Descargando archivo desde Salesforce: ${sfUrl}`);

      const sfRes = await withRetries(() =>
        fetch(sfUrl, {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` }
        }).then(async response => {
          if (!response.ok) throw new Error(`Salesforce respondió con ${response.status}`);
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          return { buffer, mimeType: response.headers.get('content-type') };
        }), 3, 1000, 'Descarga Salesforce'
      );

      const ext = mime.extension(sfRes.mimeType) || 'bin';
      const fileName = `${fileId}.${ext}`;
      const caseFolderId = await createCaseFolder(caseNumber);

      console.log(`📁 Subiendo a Drive como ${fileName}...`);

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
        }), 3, 1000, 'Subida Google Drive'
      );

      console.log(`✅ Archivo ${fileName} del caso ${caseNumber} subido exitosamente a Drive`);
      res.json({
        url: uploaded.data.webViewLink,
        driveId: uploaded.data.id,
        fileName,
        caseNumber
      });
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
