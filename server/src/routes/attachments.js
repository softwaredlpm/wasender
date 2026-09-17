const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const busboy = require('busboy');
const { authenticateUser } = require('../middleware/auth');
const { requireTenantContext } = require('../middleware/tenant');
const { success, error } = require('../utils/response');

router.use(authenticateUser);
router.use(requireTenantContext);

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads', 'campaigns');
const MAX_FILE_SIZE = 16 * 1024 * 1024; // 16 MB WhatsApp campaign attachment limit

const ALLOWED_MIME_TYPES = new Set([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword'
]);

const ALLOWED_EXTENSIONS = new Set([
    '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.docx', '.doc'
]);

/**
 * Returns tenant-isolated upload directory
 */
function getTenantUploadDir(tenantId) {
    const dir = path.join(UPLOADS_ROOT, tenantId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * POST /api/v1/attachments/upload
 * Upload campaign attachment (PDF, JPG, PNG, DOCX up to 16MB)
 */
router.post('/upload', (req, res) => {
    const tenantId = req.tenant.id;
    const contentType = req.headers['content-type'] || '';

    if (!contentType.includes('multipart/form-data')) {
        return error(res, 'Content-Type must be multipart/form-data', 400);
    }

    let bb;
    try {
        bb = busboy({
            headers: req.headers,
            limits: {
                fileSize: MAX_FILE_SIZE,
                files: 1
            }
        });
    } catch (err) {
        return error(res, `Failed to parse upload stream: ${err.message}`, 400);
    }

    const tenantDir = getTenantUploadDir(tenantId);
    let uploadedFile = null;
    let fileLimitReached = false;
    let mimeTypeError = null;
    let pendingFiles = 0;
    let isClosed = false;
    let responded = false;

    function checkDone() {
        if (responded) return;
        if (!isClosed || pendingFiles > 0) return;

        responded = true;
        if (mimeTypeError) {
            return error(res, mimeTypeError, 400);
        }
        if (fileLimitReached) {
            return error(res, `File size limit of ${MAX_FILE_SIZE / (1024 * 1024)}MB exceeded.`, 413);
        }
        if (!uploadedFile) {
            return error(res, 'No file was uploaded.', 400);
        }

        return success(res, uploadedFile, 'Attachment uploaded successfully.', 201);
    }

    bb.on('file', (name, fileStream, info) => {
        const { filename, mimeType } = info;
        const ext = path.extname(filename).toLowerCase();

        if (!ALLOWED_MIME_TYPES.has(mimeType) && !ALLOWED_EXTENSIONS.has(ext)) {
            mimeTypeError = `Unsupported file type: ${mimeType || ext}. Allowed types: PDF, JPG, PNG, WEBP, DOCX`;
            fileStream.resume(); // Drain and discard
            return;
        }

        pendingFiles++;

        const safeId = crypto.randomUUID();
        const safeBase = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
        const storedName = `${safeId}-${safeBase}`;
        const tempFilePath = path.join(tenantDir, storedName);

        const writeStream = fs.createWriteStream(tempFilePath);
        let bytesWritten = 0;

        fileStream.on('data', (chunk) => {
            bytesWritten += chunk.length;
        });

        fileStream.on('limit', () => {
            fileLimitReached = true;
            writeStream.destroy();
            if (fs.existsSync(tempFilePath)) {
                try { fs.unlinkSync(tempFilePath); } catch (_) {}
            }
            pendingFiles--;
            checkDone();
        });

        writeStream.on('error', (err) => {
            if (fs.existsSync(tempFilePath)) {
                try { fs.unlinkSync(tempFilePath); } catch (_) {}
            }
            pendingFiles--;
            checkDone();
        });

        writeStream.on('finish', () => {
            if (!fileLimitReached && !mimeTypeError) {
                uploadedFile = {
                    id: safeId,
                    filename: storedName,
                    originalName: filename,
                    mimeType,
                    size: bytesWritten,
                    url: `/api/v1/attachments/${storedName}`,
                    path: tempFilePath,
                    createdAt: new Date().toISOString()
                };
            }
            pendingFiles--;
            checkDone();
        });

        fileStream.pipe(writeStream);
    });

    bb.on('error', (err) => {
        if (!responded) {
            responded = true;
            return error(res, `Upload error: ${err.message}`, 500);
        }
    });

    bb.on('close', () => {
        isClosed = true;
        checkDone();
    });

    req.pipe(bb);
});

/**
 * GET /api/v1/attachments
 * Lists all attachments for the tenant
 */
router.get('/', (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const tenantDir = getTenantUploadDir(tenantId);
        const files = fs.readdirSync(tenantDir);

        const attachments = files.map(filename => {
            const filePath = path.join(tenantDir, filename);
            const stats = fs.statSync(filePath);
            return {
                filename,
                size: stats.size,
                createdAt: stats.birthtime,
                url: `/api/v1/attachments/${filename}`,
                path: filePath
            };
        });

        return success(res, { attachments });
    } catch (err) {
        return error(res, err.message, 500);
    }
});

/**
 * GET /api/v1/attachments/:filename
 * Serves the attachment securely (path traversal protected, tenant scoped)
 */
router.get('/:filename', (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const requestedFile = path.basename(req.params.filename);
        const tenantDir = getTenantUploadDir(tenantId);
        const filePath = path.join(tenantDir, requestedFile);

        // Path traversal defense
        if (!filePath.startsWith(tenantDir)) {
            return error(res, 'Access denied.', 403);
        }

        if (!fs.existsSync(filePath)) {
            return error(res, 'File not found.', 404);
        }

        return res.sendFile(filePath);
    } catch (err) {
        return error(res, err.message, 500);
    }
});

/**
 * DELETE /api/v1/attachments/:filename
 * Deletes an attachment from tenant storage
 */
router.delete('/:filename', (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const requestedFile = path.basename(req.params.filename);
        const tenantDir = getTenantUploadDir(tenantId);
        const filePath = path.join(tenantDir, requestedFile);

        // Path traversal defense
        if (!filePath.startsWith(tenantDir)) {
            return error(res, 'Access denied.', 403);
        }

        if (!fs.existsSync(filePath)) {
            return error(res, 'File not found.', 404);
        }

        fs.unlinkSync(filePath);
        return success(res, { deleted: true, filename: requestedFile }, 'Attachment deleted successfully.');
    } catch (err) {
        return error(res, err.message, 500);
    }
});

module.exports = router;
