const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { supabaseAdmin, isConfigured } = require('../config/supabase');
const { authenticateUser } = require('../middleware/auth');
const { requireTenantContext, requireRole } = require('../middleware/tenant');
const { success, error } = require('../utils/response');

router.use(authenticateUser);
router.use(requireTenantContext);

// In-memory mock store for unit testing & sandbox offline mode
const mockContactsStore = new Map(); // tenantId -> Map<contactId, contact>

function formatPhone(phone) {
    if (!phone) return null;
    const clean = String(phone).replace(/\D/g, '');
    if (clean.length < 10) return null;
    if (clean.length === 10) return '91' + clean;
    return clean;
}

/**
 * GET /api/v1/contacts
 * Returns paginated, searchable, tag-filtered list of contacts for the tenant.
 */
router.get('/', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { search = '', tag = '', page = 1, limit = 50 } = req.query;
        const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);

        if (isConfigured()) {
            let query = supabaseAdmin
                .from('contacts')
                .select('*', { count: 'exact' })
                .eq('tenant_id', tenantId)
                .order('name', { ascending: true })
                .range(offset, offset + parseInt(limit) - 1);

            if (search) {
                query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%,customer_code.ilike.%${search}%`);
            }

            if (tag) {
                query = query.contains('tags', [tag]);
            }

            const { data, count, error: dbErr } = await query;
            if (dbErr) return error(res, dbErr.message, 500);

            return success(res, {
                contacts: data || [],
                pagination: {
                    total: count || 0,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    totalPages: Math.ceil((count || 0) / parseInt(limit))
                }
            });
        }

        // Mock Store Mode
        const tenantMap = mockContactsStore.get(tenantId) || new Map();
        let list = Array.from(tenantMap.values());

        if (search) {
            const s = search.toLowerCase();
            list = list.filter(c => c.name.toLowerCase().includes(s) || c.phone.includes(s) || (c.customer_code && c.customer_code.toLowerCase().includes(s)));
        }

        if (tag) {
            list = list.filter(c => (c.tags || []).includes(tag));
        }

        const total = list.length;
        const paged = list.slice(offset, offset + parseInt(limit));

        return success(res, {
            contacts: paged,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (err) {
        console.error('List contacts error:', err);
        return error(res, 'Failed to fetch contacts.', 500);
    }
});

/**
 * GET /api/v1/contacts/tags
 * Returns all distinct tags across tenant contacts.
 */
router.get('/tags', async (req, res) => {
    try {
        const tenantId = req.tenant.id;

        if (isConfigured()) {
            const { data, error: dbErr } = await supabaseAdmin
                .from('contacts')
                .select('tags')
                .eq('tenant_id', tenantId);

            if (dbErr) return error(res, dbErr.message, 500);

            const allTags = new Set();
            (data || []).forEach(row => (row.tags || []).forEach(t => allTags.add(t)));
            return success(res, { tags: Array.from(allTags).sort() });
        }

        // Mock Mode
        const tenantMap = mockContactsStore.get(tenantId) || new Map();
        const allTags = new Set();
        for (const c of tenantMap.values()) {
            (c.tags || []).forEach(t => allTags.add(t));
        }
        return success(res, { tags: Array.from(allTags).sort() });

    } catch (err) {
        return error(res, 'Failed to fetch tags.', 500);
    }
});

/**
 * GET /api/v1/contacts/:contactId
 * Fetches a single contact by ID.
 */
router.get('/:contactId', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const contactId = req.params.contactId;

        if (isConfigured()) {
            const { data, error: dbErr } = await supabaseAdmin
                .from('contacts')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('id', contactId)
                .single();

            if (dbErr) return error(res, 'Contact not found.', 404);
            return success(res, { contact: data, ...data });
        }

        const tenantMap = mockContactsStore.get(tenantId);
        const contact = tenantMap?.get(contactId);
        if (!contact) return error(res, 'Contact not found.', 404);

        return success(res, { contact, ...contact });
    } catch (err) {
        return error(res, err.message, 500);
    }
});

/**
 * POST /api/v1/contacts
 * Adds a new contact to the tenant address book.
 */
router.post('/', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { name, phone, email, customerCode, customer_code, tags = [], metadata = {} } = req.body;

        if (!name || !phone) {
            return error(res, 'Name and phone number are required.', 400);
        }

        const formattedPhone = formatPhone(phone);
        if (!formattedPhone) {
            return error(res, 'Invalid phone number. Must contain at least 10 digits.', 400);
        }

        const normalizedTags = Array.isArray(tags) ? tags.map(t => t.trim()).filter(Boolean) : [];

        if (isConfigured()) {
            const { data, error: insertErr } = await supabaseAdmin
                .from('contacts')
                .insert({
                    tenant_id: tenantId,
                    name,
                    phone: formattedPhone,
                    email: email || null,
                    customer_code: customerCode || customer_code || null,
                    tags: normalizedTags,
                    metadata
                })
                .select()
                .single();

            if (insertErr) {
                if (insertErr.code === '23505') {
                    return error(res, 'A contact with this phone number already exists in your address book.', 409);
                }
                return error(res, insertErr.message, 500);
            }

            return success(res, { id: data.id, contact: data, ...data }, 'Contact created successfully.', 201);
        }

        // Mock Mode
        if (!mockContactsStore.has(tenantId)) {
            mockContactsStore.set(tenantId, new Map());
        }
        const tenantMap = mockContactsStore.get(tenantId);

        // Check duplicate phone
        for (const existing of tenantMap.values()) {
            if (existing.phone === formattedPhone) {
                return error(res, 'A contact with this phone number already exists in your address book.', 409);
            }
        }

        const newContact = {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            name,
            phone: formattedPhone,
            email: email || null,
            customer_code: customerCode || customer_code || null,
            tags: normalizedTags,
            metadata,
            created_at: new Date().toISOString()
        };

        tenantMap.set(newContact.id, newContact);
        return success(res, { id: newContact.id, contact: newContact, ...newContact }, 'Contact created successfully (Test Mode).', 201);

    } catch (err) {
        console.error('Create contact error:', err);
        return error(res, 'Failed to create contact.', 500);
    }
});

/**
 * PUT / PATCH /api/v1/contacts/:contactId
 * Updates contact information.
 */
async function updateContactHandler(req, res) {
    try {
        const tenantId = req.tenant.id;
        const contactId = req.params.contactId;
        const { name, phone, email, customerCode, customer_code, tags, metadata } = req.body;

        const updates = { updated_at: new Date().toISOString() };
        if (name !== undefined) updates.name = name;
        if (phone !== undefined) {
            const formatted = formatPhone(phone);
            if (!formatted) return error(res, 'Invalid phone format.', 400);
            updates.phone = formatted;
        }
        if (email !== undefined) updates.email = email;
        if (customerCode !== undefined || customer_code !== undefined) {
            updates.customer_code = customerCode || customer_code;
        }
        if (tags !== undefined) {
            updates.tags = Array.isArray(tags) ? tags.map(t => t.trim()).filter(Boolean) : [];
        }
        if (metadata !== undefined) updates.metadata = metadata;

        if (isConfigured()) {
            const { data, error: updErr } = await supabaseAdmin
                .from('contacts')
                .update(updates)
                .eq('tenant_id', tenantId)
                .eq('id', contactId)
                .select()
                .single();

            if (updErr) return error(res, updErr.message, 500);
            return success(res, { contact: data, ...data }, 'Contact updated successfully.');
        }

        const tenantMap = mockContactsStore.get(tenantId);
        if (!tenantMap || !tenantMap.has(contactId)) {
            return error(res, 'Contact not found.', 404);
        }

        const contact = tenantMap.get(contactId);
        Object.assign(contact, updates);
        return success(res, { contact, ...contact }, 'Contact updated.');

    } catch (err) {
        return error(res, 'Failed to update contact.', 500);
    }
}

router.put('/:contactId', updateContactHandler);
router.patch('/:contactId', updateContactHandler);

/**
 * POST /api/v1/contacts/import-csv
 * Bulk imports an array or CSV text of contacts with automated phone sanitization.
 */
router.post('/import-csv', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        let contacts = req.body.contacts || [];

        // Parse CSV string if passed directly in body
        if (typeof req.body.csv === 'string') {
            const lines = req.body.csv.trim().split(/\r?\n/);
            if (lines.length > 1) {
                const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
                contacts = [];
                for (let i = 1; i < lines.length; i++) {
                    const row = lines[i].trim();
                    if (!row) continue;
                    const cols = row.split(',').map(c => c.trim());
                    const obj = {};
                    headers.forEach((h, idx) => { obj[h] = cols[idx] || ''; });
                    contacts.push(obj);
                }
            }
        }

        if (!Array.isArray(contacts) || contacts.length === 0) {
            return error(res, 'Contacts array or CSV payload is required for bulk import.', 400);
        }

        const validContacts = [];
        let skipped = 0;

        for (const raw of contacts) {
            const phone = formatPhone(raw.phone || raw.mobile || raw.number);
            const name = (raw.name || raw.customer_name || 'Customer').trim();

            if (!phone) {
                skipped++;
                continue;
            }

            let tags = [];
            if (Array.isArray(raw.tags)) {
                tags = raw.tags;
            } else if (typeof raw.tags === 'string') {
                tags = raw.tags.split(',').map(t => t.trim()).filter(Boolean);
            }

            validContacts.push({
                tenant_id: tenantId,
                name,
                phone,
                email: raw.email || null,
                customer_code: raw.customerCode || raw.customer_code || null,
                tags,
                metadata: raw.metadata || {}
            });
        }

        if (validContacts.length === 0) {
            return error(res, 'No valid contacts found with valid phone numbers.', 400);
        }

        if (isConfigured()) {
            const { data, error: upsertErr } = await supabaseAdmin
                .from('contacts')
                .upsert(validContacts, { onConflict: 'tenant_id,phone' })
                .select('id, name, phone');

            if (upsertErr) return error(res, upsertErr.message, 500);

            return success(res, {
                imported: validContacts.length,
                importedCount: validContacts.length,
                skipped: skipped,
                skippedCount: skipped
            }, `Successfully imported ${validContacts.length} contacts.`);
        }

        // Mock Mode
        if (!mockContactsStore.has(tenantId)) mockContactsStore.set(tenantId, new Map());
        const tenantMap = mockContactsStore.get(tenantId);

        for (const c of validContacts) {
            let existingId = null;
            for (const [id, item] of tenantMap.entries()) {
                if (item.phone === c.phone) {
                    existingId = id;
                    break;
                }
            }

            const id = existingId || crypto.randomUUID();
            tenantMap.set(id, { id, ...c, created_at: new Date().toISOString() });
        }

        return success(res, {
            imported: validContacts.length,
            importedCount: validContacts.length,
            skipped: skipped,
            skippedCount: skipped
        }, `Successfully imported ${validContacts.length} contacts (Test Mode).`);

    } catch (err) {
        console.error('Import contacts error:', err);
        return error(res, 'Failed to import contacts.', 500);
    }
});

/**
 * DELETE /api/v1/contacts/:contactId
 * Deletes a contact from the address book.
 */
router.delete('/:contactId', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const contactId = req.params.contactId;

        if (isConfigured()) {
            const { error: delErr } = await supabaseAdmin
                .from('contacts')
                .delete()
                .eq('tenant_id', tenantId)
                .eq('id', contactId);

            if (delErr) return error(res, delErr.message, 500);
            return success(res, {}, 'Contact deleted successfully.');
        }

        const tenantMap = mockContactsStore.get(tenantId);
        if (tenantMap) tenantMap.delete(contactId);
        return success(res, {}, 'Contact deleted.');

    } catch (err) {
        return error(res, 'Failed to delete contact.', 500);
    }
});

module.exports = router;
