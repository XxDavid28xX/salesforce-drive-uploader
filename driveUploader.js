async function processInBatches(items, batchSize, processorFn) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    // Procesa en paralelo los de este batch
    await Promise.all(batch.map(processorFn));
  }
}
const MAX_FILE_SIZE_MB = 512; // ajusta según tu RAM/Render, Google Drive soporta mucho más
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

const express = require('express');
const multer = require('multer');

const fs = require('fs');
const mime = require('mime-types');
require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { Readable } = require('stream');
const app = express();
app.use(express.json({ limit: '50mb' })); // Por si mandas JSON grande de archivos
const upload = multer({ dest: 'uploads/' });
const { Storage } = require('@google-cloud/storage');
const path = require('path');

// 🧱 Reconstruye el archivo JSON desde variable de entorno base64
const credsPath = path.join('/tmp', 'gcs-creds.json');
fs.writeFileSync(credsPath, Buffer.from(process.env.GCS_CREDENTIALS_JSON_BASE64, 'base64'));

// 📦 Inicializa cliente de GCS
const storage = new Storage({ keyFilename: credsPath });
const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);

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
    const folderPrefix = `prod/casos/${caseNumber}/`;

    // 2️⃣ Subir a GCS
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

    // 3️⃣ Crear log_general.csv
    const logPath = 'prod/logs/log_general.csv';
let logPrevio = '';
try {
  // Descarga el log previo si existe
  const [exists] = await bucket.file(logPath).exists();
  if (exists) {
    const [contents] = await bucket.file(logPath).download();
    logPrevio = contents.toString('utf-8');
    // Quita encabezado si ya está
    logPrevio = logPrevio.split('\n').slice(1).join('\n');
  }
} catch (e) {
  console.warn('⚠️ No se pudo descargar log previo (quizá aún no existe):', e.message);
}

// Prepara encabezado y filas nuevas
const encabezado = 'fileName,caseNumber,status,error\n';
const filas = resultados.map(r =>
  `${r.fileName},${r.caseNumber},${r.status},"${r.error ? r.error.replace(/"/g, '""') : ''}"`
).join('\n');

// Une el contenido: encabezado una vez, luego todo el histórico
let nuevoContenido;
if (logPrevio.trim()) {
  nuevoContenido = encabezado + logPrevio.trim() + '\n' + filas + '\n';
} else {
  nuevoContenido = encabezado + filas + '\n';
}

// Sube el archivo completo
try {
  await bucket.file(logPath).save(Buffer.from(nuevoContenido, 'utf-8'), {
    metadata: { contentType: 'text/csv' }
  });
  console.log(`📄 Log global actualizado en GCS: ${logPath}`);
} catch (e) {
  console.error('❌ Error subiendo log_general.csv:', e.message);
}
    // 4️⃣ Marcar caso en Salesforce si todo fue exitoso
    let carpetaPublica = null;

    if (todosExito) {
      carpetaPublica = `https://storage.googleapis.com/${process.env.GCS_BUCKET_NAME}/${folderPrefix}`;
      try {
        const sfUpdateToken = await obtenerAccessTokenSalesforce();
        const queryUrl = `${process.env.SF_INSTANCE_URL}/services/data/v64.0/query?q=SELECT+Id+FROM+Case+WHERE+CaseNumber='${caseNumber}'`;
        const queryRes = await fetch(queryUrl, {
          headers: { Authorization: `Bearer ${sfUpdateToken}` }
        });

        if (!queryRes.ok) {
          throw new Error(`Falló búsqueda del caso en Salesforce (${queryRes.status})`);
        }

        const queryData = await queryRes.json();
        const caseId = queryData.records?.[0]?.Id;

        if (!caseId) {
          throw new Error(`No se encontró un caso con CaseNumber ${caseNumber}`);
        }

        const sfPatchUrl = `${process.env.SF_INSTANCE_URL}/services/data/v64.0/sobjects/Case/${caseId}`;
        const updateBody = {
          Subido_a_Drive__c: true,
          External_File_URL__c: carpetaPublica
        };

        const patchRes = await fetch(sfPatchUrl, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${sfUpdateToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updateBody)
        });

        if (!patchRes.ok) {
          throw new Error(`Falló actualización en Salesforce (${patchRes.status})`);
        }

        console.log(`✅ Caso ${caseNumber} actualizado en Salesforce.`);
      } catch (e) {
        console.error('❌ Error al actualizar el caso en Salesforce:', e.message);
      }
    }

    // 5️⃣ Respuesta
    res.status(todosExito ? 200 : 207).json({
      status: todosExito ? 'OK' : 'INCOMPLETE',
      success: todosExito,
      folderPrefix,
      carpetaPublica,
      resultados
    });

  } catch (err) {
    console.error('❌ Error general en /uploadFromSalesforceLote:', err.message);
    res.status(500).json({ error: 'Error en batch de subida de archivos', detalle: err.message });
  }
});


app.get('/', (req, res) => {
  res.send('✅ Middleware activo y escuchando');
});

app.listen(3000, () => {
  console.log('🚀 Servidor escuchando en puerto 3000');
});

