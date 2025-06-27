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

const fs = require('fs');
const mime = require('mime-types');
require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.json({ limit: '50mb' })); // Por si mandas JSON grande de archivos
const upload = multer({ dest: 'uploads/' });
const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs');

// 🧱 Reconstruye el archivo JSON desde variable de entorno base64
const credsPath = path.join('/tmp', 'gcs-creds.json');
fs.writeFileSync(credsPath, Buffer.from(process.env.GCS_CREDENTIALS_JSON_BASE64, 'base64'));

// 📦 Inicializa cliente de GCS
const storage = new Storage({ keyFilename: credsPath });
const bucket = storage.bucket('NOMBRE_DE_TU_BUCKET'); // <-- Reemplaza con tu bucket real

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

const { Readable } = require('stream');
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

    // 1️⃣ Descargar y validar cada archivo desde Salesforce
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

        const salesforceToken = await obtenerAccessTokenSalesforce();
        const sfRes = await withRetries(() =>
          fetch(sfUrl, {
            method: 'GET',
            headers: { Authorization: `Bearer ${salesforceToken}` }
          }).then(async response => {
            if (!response.ok) throw new Error(`Salesforce respondió con ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            if (buffer.length > MAX_FILE_SIZE_BYTES) {
              throw new Error(`El archivo supera el límite de ${MAX_FILE_SIZE_MB} MB`);
            }
            return { buffer, mimeType: response.headers.get('content-type') };
          }), 3, 1000, `Descarga Salesforce ${fileId}`
        );

        let detected;
        try {
          detected = await fileType.fromBuffer(sfRes.buffer);
        } catch (e) {
          console.warn(`⚠️ No se pudo detectar MIME por buffer para ${fileId}: ${e.message}`);
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
    const folderPrefix = `casos/${caseNumber}/`;

    // 2️⃣ Subir los archivos a Google Cloud Storage
    if (todosExito) {
      await processInBatches(files, 10, async (file) => {
        try {
          console.log(`☁️ Subiendo ${file.fileName} a GCS...`);
          await withRetries(() =>
            bucket.file(`${folderPrefix}${file.fileName}`).save(file.buffer, {
              metadata: { contentType: file.mimeType }
            }), 3, 1000, `Subida GCS ${file.fileName}`
          );
        } catch (e) {
          console.error(`❌ Error subiendo ${file.fileName} a GCS:`, e.message);
        }
      });
    }

    // 3️⃣ Crear log_general.csv y subirlo a GCS
    const generalLogFileName = 'log_general.csv';
    const encabezado = 'fileName,caseNumber,status,error\n';
    const filas = resultados.map(r =>
      `${r.fileName},${r.caseNumber},${r.status},"${r.error ? r.error.replace(/"/g, '""') : ''}"`
    ).join('\n');
    const logContenido = encabezado + filas;

    try {
      const logPath = `logs/${generalLogFileName}`;
      await bucket.file(logPath).save(Buffer.from(logContenido, 'utf-8'), {
        metadata: { contentType: 'text/csv' }
      });
      console.log(`📄 Log subido a GCS: ${logPath}`);
    } catch (e) {
      console.error('❌ Error subiendo log_general.csv:', e.message);
    }

    // 4️⃣ Respuesta
    res.status(todosExito ? 200 : 207).json({
      status: todosExito ? 'OK' : 'INCOMPLETE',
      success: todosExito,
      folderPrefix,
      resultados
    });

  } catch (err) {
    console.error('❌ Error general en /uploadFromSalesforceLote:', err.message);
    res.status(500).json({ error: 'Error en batch de subida de archivos', detalle: err.message });
  }
});

const { Readable } = require('stream');
const mime = require('mime-types');
const fileType = require('file-type');

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
          if (buffer.length > MAX_FILE_SIZE_BYTES) {
            throw new Error(`El archivo supera el límite permitido de ${MAX_FILE_SIZE_MB} MB`);
          }
          return { buffer, mimeType: response.headers.get('content-type') };
        }), 3, 1000, `Descarga Salesforce ${fileId}`
      );

      let detected;
      try {
        detected = await fileType.fromBuffer(sfRes.buffer);
      } catch (e) {
        console.warn(`⚠️ No se pudo detectar MIME por buffer: ${e.message}`);
      }

      const mimeTypeFinal = detected?.mime || sfRes.mimeType;
      const extFinal = detected?.ext || mime.extension(mimeTypeFinal) || 'bin';
      const nombreBase = nombreDesdeSalesforce || fileId;
      const yaTieneExtension = /\.[a-zA-Z0-9]{2,5}$/.test(nombreBase);
      const finalFileName = yaTieneExtension ? nombreBase : `${nombreBase}.${extFinal}`;
      const folderPrefix = `casos/${caseNumber}/`;
      const gcsPath = `${folderPrefix}${finalFileName}`;

      console.log(`📁 Subiendo a GCS como ${gcsPath}...`);

      await withRetries(() =>
        bucket.file(gcsPath).save(sfRes.buffer, {
          metadata: { contentType: mimeTypeFinal }
        }), 3, 1000, 'Subida GCS'
      );

      console.log(`✅ Archivo ${finalFileName} del caso ${caseNumber} subido exitosamente a GCS`);
      res.json({
        bucketPath: gcsPath,
        fileName: finalFileName,
        caseNumber
      });
    });

  } catch (err) {
    console.error('❌ Error general en /uploadFromSalesforce:', err.message);
    res.status(500).json({ error: 'Error al subir archivo desde Salesforce', detalle: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('✅ Middleware activo y escuchando');
});

app.listen(3000, () => {
  console.log('🚀 Servidor escuchando en puerto 3000');
});

