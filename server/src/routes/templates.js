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
const mockTemplatesStore = new Map(); // tenantId -> Map<templateId, template>

/**
 * Extracts variable names from mustache string (e.g. {{customer_name}}, {{amount}})
 */
function extractVariables(content) {
    if (!content) return [];
    const matches = content.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) || [];
    const vars = new Set();
    for (const m of matches) {
        const key = m.replace(/[\{\}\s]/g, '');
        if (key) vars.add(key);
    }
    return Array.from(vars);
}

/**
 * GET /api/v1/templates
 * Lists all message templates for the tenant.
 */
router.get('/', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { category = '' } = req.query;

        if (isConfigured()) {
            let query = supabaseAdmin
                .from('message_templates')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('name', { ascending: true });

            if (category) {
                query = query.eq('category', category);
            }

            const { data, error: dbErr } = await query;
            if (dbErr) return error(res, dbErr.message, 500);
            return success(res, { templates: data || [] });
        }

        // Mock Store Mode
        const tenantMap = mockTemplatesStore.get(tenantId) || new Map();
        let list = Array.from(tenantMap.values());
        if (category) {
            list = list.filter(t => t.category === category);
        }
        return success(res, { templates: list });

    } catch (err) {
        console.error('List templates error:', err);
        return error(res, 'Failed to fetch templates.', 500);
    }
});

/**
 * GET /api/v1/templates/:templateId
 * Gets a single template by ID.
 */
router.get('/:templateId', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const templateId = req.params.templateId;

        if (isConfigured()) {
            const { data, error: dbErr } = await supabaseAdmin
                .from('message_templates')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('id', templateId)
                .single();

            if (dbErr) return error(res, 'Template not found.', 404);
            return success(res, { template: data, ...data });
        }

        const tenantMap = mockTemplatesStore.get(tenantId);
        const t = tenantMap?.get(templateId);
        if (!t) return error(res, 'Template not found.', 404);

        return success(res, { template: t, ...t });
    } catch (err) {
        return error(res, err.message, 500);
    }
});

/**
 * POST /api/v1/templates
 * Creates a new message template and automatically extracts variable tokens.
 */
router.post('/', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const { name, content, category = 'general' } = req.body;

        if (!name || !content) {
            return error(res, 'Template name and content are required.', 400);
        }

        const variables = extractVariables(content);

        if (isConfigured()) {
            const { data, error: insertErr } = await supabaseAdmin
                .from('message_templates')
                .insert({
                    tenant_id: tenantId,
                    name,
                    content,
                    category,
                    variables
                })
                .select()
                .single();

            if (insertErr) return error(res, insertErr.message, 500);
            return success(res, { id: data.id, template: data, ...data }, 'Template created successfully.', 201);
        }

        // Mock Mode
        if (!mockTemplatesStore.has(tenantId)) mockTemplatesStore.set(tenantId, new Map());
        const tenantMap = mockTemplatesStore.get(tenantId);

        const newTemplate = {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            name,
            content,
            category,
            variables,
            created_at: new Date().toISOString()
        };

        tenantMap.set(newTemplate.id, newTemplate);
        return success(res, { id: newTemplate.id, template: newTemplate, ...newTemplate }, 'Template created successfully (Test Mode).', 201);

    } catch (err) {
        console.error('Create template error:', err);
        return error(res, 'Failed to create template.', 500);
    }
});

/**
 * PUT / PATCH /api/v1/templates/:templateId
 * Updates an existing template and recalculates variables if content changes.
 */
async function updateTemplateHandler(req, res) {
    try {
        const tenantId = req.tenant.id;
        const templateId = req.params.templateId;
        const { name, content, category } = req.body;

        const updates = { updated_at: new Date().toISOString() };
        if (name !== undefined) updates.name = name;
        if (content !== undefined) {
            updates.content = content;
            updates.variables = extractVariables(content);
        }
        if (category !== undefined) updates.category = category;

        if (isConfigured()) {
            const { data, error: updateErr } = await supabaseAdmin
                .from('message_templates')
                .update(updates)
                .eq('tenant_id', tenantId)
                .eq('id', templateId)
                .select()
                .single();

            if (updateErr) return error(res, updateErr.message, 500);
            return success(res, { template: data, ...data }, 'Template updated successfully.');
        }

        const tenantMap = mockTemplatesStore.get(tenantId);
        if (tenantMap && tenantMap.has(templateId)) {
            const t = tenantMap.get(templateId);
            Object.assign(t, updates);
            return success(res, { template: t, ...t }, 'Template updated.');
        }

        return error(res, 'Template not found.', 404);

    } catch (err) {
        return error(res, 'Failed to update template.', 500);
    }
}

router.put('/:templateId', updateTemplateHandler);
router.patch('/:templateId', updateTemplateHandler);

/**
 * DELETE /api/v1/templates/:templateId
 * Deletes a template.
 */
router.delete('/:templateId', async (req, res) => {
    try {
        const tenantId = req.tenant.id;
        const templateId = req.params.templateId;

        if (isConfigured()) {
            const { error: delErr } = await supabaseAdmin
                .from('message_templates')
                .delete()
                .eq('tenant_id', tenantId)
                .eq('id', templateId);

            if (delErr) return error(res, delErr.message, 500);
            return success(res, {}, 'Template deleted successfully.');
        }

        const tenantMap = mockTemplatesStore.get(tenantId);
        if (tenantMap) tenantMap.delete(templateId);
        return success(res, {}, 'Template deleted.');

    } catch (err) {
        return error(res, 'Failed to delete template.', 500);
    }
});

module.exports = router;
