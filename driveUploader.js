async function processInBatches(items, batchSize, processorFn) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    // Procesa en paralelo los de este batch
    await Promise.all(batch.map(processorFn));
  }
}
const MAX_FILE_SIZE_MB = 512; // ajusta según tu RAM/Render, Google Drive soporta mucho más
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
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
 
// Autenticación con Google OAuth2 (ajustada para usar variables específicas)
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID_GOOGLE,
  process.env.CLIENT_SECRET_GOOGLE,
  process.env.REDIRECT_URI_GOOGLE
);
oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN_GOOGLE });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

async function obtenerAccessTokenSalesforce() {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');  // o "authorization_code" si usas ese flujo
  params.append('client_id', process.env.CLIENT_ID_SF);
  params.append('client_secret', process.env.CLIENT_SECRET_SF);
  params.append('refresh_token', process.env.REFRESH_TOKEN_SF);

  // DEBUG: mostrar los valores (menos el secreto en producción)
  console.log('SF_INSTANCE_URL:', process.env.SF_INSTANCE_URL);
  console.log('CLIENT_ID_SF:', process.env.CLIENT_ID_SF);
  console.log('REFRESH_TOKEN_SF:', process.env.REFRESH_TOKEN_SF ? '***' : 'NO SET');
  console.log('PARAMS:', params.toString());

  const response = await fetch(`${process.env.SF_INSTANCE_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!response.ok) {
    const errorText = await response.text(); // <-- esto te da el mensaje de error real de Salesforce
    console.error(`❌ Falló autenticación Salesforce: ${response.status} - ${errorText}`);
    throw new Error(`❌ Falló autenticación Salesforce: ${response.status} - ${errorText}`);
  }

  const json = await response.json();
  return json.access_token;
}


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

// Crear o buscar carpeta para el caso (con búsqueda antes de crear)
async function createCaseFolder(parentId) {
  const folderName = String(parentId || '').trim();
  if (!folderName) throw new Error('parentId inválido para carpeta');

  try {
    console.log(`🔍 Buscando carpeta existente para caso: "${folderName}"`);
    const search = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and '${process.env.FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id, name)',
      spaces: 'drive'
    });

    if (search.data.files.length > 0) {
      const foundId = search.data.files[0].id;
      console.log(`📂 Carpeta ya existe para caso "${folderName}": ${foundId}`);
      return foundId;
    }

    // Si no existe, la creas
    console.log(`📁 Carpeta NO encontrada, creando nueva para caso: "${folderName}"`);
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

    console.log(`🆕 Carpeta creada para caso "${folderName}": ${folder.data.id}`);
    return folder.data.id;
  } catch (error) {
    console.error(`❌ Error creando/obteniendo carpeta para caso "${folderName}":`, error.message);
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

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const fileType = require('file-type');

app.post('/uploadFromSalesforceLote', async (req, res) => {
  try {
    console.log('📨 Nueva solicitud POST /uploadFromSalesforceLote recibida');
    const { files, caseNumber, accessToken } = req.body;

    if (!files || !Array.isArray(files) || files.length === 0 || !caseNumber || !accessToken) {
      console.warn('⚠️ Payload inválido: falta files, caseNumber o accessToken');
      return res.status(400).json({ error: 'Payload inválido, se requiere files, caseNumber y accessToken' });
    }

    const resultados = [];

    // 1️⃣ Validar y descargar todos los archivos primero
    for (const file of files) {
      const { fileId, type, fileName: nombreDesdeSalesforce } = file;
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
        const salesforceToken = await obtenerAccessTokenSalesforce();
        const sfRes = await withRetries(() =>
          fetch(sfUrl, {
            method: 'GET',
            headers: { Authorization: `Bearer ${salesforceToken}` }
          }).then(async response => {
            if (!response.ok) throw new Error(`Salesforce respondió con ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            return { buffer, mimeType: response.headers.get('content-type') };
          }), 3, 1000, `Descarga Salesforce ${fileId}`
        );

        // 🔍 Detección robusta del tipo MIME y extensión real
       let detected;
try {
  detected = await fileType.fromBuffer(sfRes.buffer);
} catch (e) {
  console.warn(`⚠️ No se pudo detectar MIME por buffer para ${fileId}, usando fallback: ${e.message}`);
}

const mimeTypeFinal = detected?.mime || sfRes.mimeType;
const extFinal = detected?.ext || mime.extension(mimeTypeFinal) || 'bin';

const nombreBase = nombreDesdeSalesforce || fileId;
const yaTieneExtension = /\.[a-zA-Z0-9]{2,5}$/.test(nombreBase);
file.fileName = yaTieneExtension ? nombreBase : `${nombreBase}.${extFinal}`;
file.buffer = sfRes.buffer;
file.mimeType = mimeTypeFinal;


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

    const todosExito = resultados.every(r => r.status === 'SUCCESS');
    const erroresFolder = process.env.ERRORES_FOLDER_ID;
    let logDriveLink = null;
    let folderId = null;

    // 2️⃣ Si todos son válidos, crear carpeta y subir archivos
    if (todosExito) {
      folderId = await createCaseFolder(caseNumber);

      await processInBatches(files, 10, async (file) => {
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
});

    }

    // 3️⃣ Actualiza/crea log_general.csv con todos los resultados
    const generalLogFileName = 'log_general.csv';
    let contenidoPrevio = '';
    let logFileId = null;

    if (erroresFolder) {
      const generalLogs = await drive.files.list({
        q: `name='${generalLogFileName}' and '${erroresFolder}' in parents and trashed=false`,
        fields: 'files(id)',
        spaces: 'drive'
      });
      if (generalLogs.data.files.length > 0) {
        logFileId = generalLogs.data.files[0].id;
        const resp = await drive.files.get({ fileId: logFileId, alt: 'media' }, { responseType: 'stream' });
        contenidoPrevio = await streamToString(resp.data);
        await drive.files.delete({ fileId: logFileId });
      }

      const encabezado = 'fileName,caseNumber,status,error\n';
      const filasNuevas = generarCSV(resultados).replace(encabezado, '');
      const nuevoContenido = contenidoPrevio
        ? (contenidoPrevio.endsWith('\n') ? contenidoPrevio : contenidoPrevio + '\n') + filasNuevas
        : encabezado + filasNuevas;

      const uploaded = await subirArchivoBufferDrive(Buffer.from(nuevoContenido, 'utf-8'), erroresFolder, generalLogFileName);
      logDriveLink = uploaded.data.webViewLink;
    }

    // 4️⃣ Devolver respuesta
    res.status(todosExito ? 200 : 207).json({
      status: todosExito ? 'OK' : 'INCOMPLETE',
      success: todosExito,
      folderId,
      folderUrl: folderId ? `https://drive.google.com/drive/folders/${folderId}` : null,
      logFile: logDriveLink,
      resultados
    });

  } catch (err) {
    console.error('❌ Error general en /uploadFromSalesforceLote:', err.message);
    res.status(500).json({ error: 'Error en batch de subida de archivos', detalle: err.message });
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
      const { fileId, type, caseNumber, accessToken, fileName: nombreDesdeSalesforce } = JSON.parse(data);

      if (!fileId || !type || !caseNumber || !accessToken) {
        console.warn('⚠️ Parámetros faltantes en payload');
        return res.status(400).json({ error: 'Faltan parámetros requeridos' });
      }

      const sfUrl = type === 'attachment'
        ? `${process.env.SF_INSTANCE_URL}/services/data/v64.0/sobjects/Attachment/${fileId}/Body`
        : `${process.env.SF_INSTANCE_URL}/services/data/v64.0/sobjects/ContentVersion/${fileId}/VersionData`;

      console.log(`🔗 Descargando archivo desde Salesforce: ${sfUrl}`);

      const salesforceToken = await obtenerAccessTokenSalesforce();
const sfRes = await withRetries(() =>
  fetch(sfUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${salesforceToken}` }
  }).then(async response => {
    if (!response.ok) throw new Error(`Salesforce respondió con ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return { buffer, mimeType: response.headers.get('content-type') };
  }), 3, 1000, 'Descarga Salesforce'
);

     const nombreBase = nombreDesdeSalesforce || fileId;
const yaTieneExtension = /\.[a-zA-Z0-9]{2,5}$/.test(nombreBase);
const ext = mime.extension(sfRes.mimeType) || 'bin';

// Solo agrega la extensión si no tiene ninguna
file.fileName = yaTieneExtension ? nombreBase : `${nombreBase}.${ext}`;

      const caseFolderId = await createCaseFolder(caseNumber);

console.log(`📁 Subiendo a Drive como ${file.fileName}...`);

      const uploaded = await withRetries(() =>
        drive.files.create({
          resource: {
            name: file.fileName,
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
