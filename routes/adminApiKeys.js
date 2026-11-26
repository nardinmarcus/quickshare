const config = require('../config');
const express = require('express');
const { randomBytes } = require('node:crypto');
const { respondIfPublishingGate } = require('../middleware/responsePolicy');
const {
  normalizeApiKeyScopes,
  parseApiKeyScopes,
  toCredentialVersionString
} = require('../utils/apiKeyIdentity');
const {
  createCsrfToken,
  generateId,
  hashSecret
} = require('../utils/security');
const { hasAnyGrantPermission, normalizeGrantPermissions } = require('../utils/shareGrants');

function createAdminApiKeysRouter({ config, pageRepository, auth, parsers }) {
  const router = express.Router();
  const {
    dashboardSessionToken,
    requireDashboardAdmin,
    requireDashboardApiAdmin,
    requireDashboardCsrf
  } = auth;
  const {
    parseSmallJson
  } = parsers;

  router.get('/admin/apis', requireDashboardAdmin, async (req, res) => {
    try {
      const apiKeys = await pageRepository.listApiKeys();
      // The grant panel (T12) lets the owner pick a target Share per Key;
      // only the ID and the owner's own title are needed for the picker.
      const pages = await pageRepository.listAdminPages({ limit: null });
      const grantableShares = pages.map(page => ({ id: page.id, title: page.title || null }));
      const sessionToken = dashboardSessionToken(req);

      return res.render('admin-apis', {
        title: 'QuickShare | API 管理',
        page: 'admin-apis',
        apiKeys: apiKeys.map(apiKey => ({
          ...apiKey,
          scopeList: parseApiKeyScopes(apiKey.scopes)
        })),
        grantableShares,
        legacyApiKeyConfigured: Boolean(config.shareApiKey),
        csrfToken: config.authEnabled ? createCsrfToken(sessionToken) : ''
      });
    } catch (error) {
      console.error('API management page failed:', error);
      return res.status(500).render('error', {
        title: 'Server Error',
        page: 'error-page',
        message: 'Unable to load API management'
      });
    }
  });

  router.post('/admin/apis/keys', requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim();

      if (!name || name.length > 80) {
        return res.status(400).json({
          success: false,
          error: 'Key name must be between 1 and 80 characters'
        });
      }

      const id = generateId(12);
      const secret = randomBytes(32).toString('base64url');
      const apiKey = await pageRepository.createApiKey({
        id,
        name,
        keyHash: await hashSecret(secret),
        keyPrefix: `qs.${id.slice(0, 8)}…`,
        createdAt: Date.now()
      });

      pageRepository.createAuditLog({
        action: 'api_key.create',
        pageId: null,
        details: JSON.stringify({ apiKeyId: apiKey.id, name: apiKey.name }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.status(201).json({
        success: true,
        apiKey: {
          id: apiKey.id,
          name: apiKey.name,
          key_prefix: apiKey.key_prefix,
          created_at: apiKey.created_at,
          last_used_at: apiKey.last_used_at,
          credential_version: toCredentialVersionString(apiKey.credential_version),
          // A new managed Key starts create-only (T12), like every Key
          // migrated by 010; the owner widens it explicitly if at all.
          scopes: [...parseApiKeyScopes(apiKey.scopes)],
          auto_grant_new_share_edit: apiKey.auto_grant_new_share_edit === true,
          secret: `qs.${id}.${secret}`
        }
      });
    } catch (error) {
      console.error('Create API key failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to create API key'
      });
    }
  });

  // Rotation (T05): the logical Key keeps its ID, name and creation time; a
  // fresh secret replaces the old one and the credential version advances in
  // the same gated write, so the old secret stops working the moment this
  // succeeds — including for requests that already verified it but have not
  // written yet. The new secret is shown only in this success response. A Key
  // is a credential, not a Share owner: rotation changes nothing about any
  // Share.
  router.post('/admin/apis/keys/:id/rotate', requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
    try {
      const secret = randomBytes(32).toString('base64url');
      const rotated = await pageRepository.rotateApiKey(req.params.id, {
        keyHash: await hashSecret(secret),
        keyPrefix: `qs.${req.params.id.slice(0, 8)}…`
      });

      if (!rotated) {
        return res.status(404).json({
          success: false,
          error: 'API key not found'
        });
      }

      pageRepository.createAuditLog({
        action: 'api_key.rotate',
        pageId: null,
        details: JSON.stringify({
          apiKeyId: rotated.id,
          credentialVersion: toCredentialVersionString(rotated.credential_version)
        }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.json({
        success: true,
        apiKey: {
          id: rotated.id,
          name: rotated.name,
          key_prefix: rotated.key_prefix,
          created_at: rotated.created_at,
          last_used_at: rotated.last_used_at,
          credential_version: toCredentialVersionString(rotated.credential_version),
          // Rotation changes only the secret: scopes and grants belong to
          // the logical Key and are reported unchanged (T12).
          scopes: [...parseApiKeyScopes(rotated.scopes)],
          auto_grant_new_share_edit: rotated.auto_grant_new_share_edit === true,
          secret: `qs.${rotated.id}.${secret}`
        }
      });
    } catch (error) {
      console.error('Rotate API key failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to rotate API key'
      });
    }
  });

  router.delete('/admin/apis/keys/:id', requireDashboardAdmin, requireDashboardCsrf, async (req, res) => {
    try {
      const deleted = await pageRepository.deleteApiKey(req.params.id);

      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: 'API key not found'
        });
      }

      pageRepository.createAuditLog({
        action: 'api_key.delete',
        pageId: null,
        details: JSON.stringify({ apiKeyId: req.params.id }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.json({ success: true });
    } catch (error) {
      console.error('Delete API key failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to delete API key'
      });
    }
  });

  // Scope assignment (T12): the owner widens or narrows what a managed
  // Key may attempt. Only the scopes whose behavior exists are
  // assignable here; accepting a scope whose operation has not shipped
  // would hand the owner a switch that changes nothing observable, so
  // such scopes were refused as unsupported instead of silently stored
  // until their own tickets landed. A scope by itself still authorizes
  // no specific Share: resource access needs the matching grant as well.
  // The scopes the owner may assign from this dashboard. Every entry
  // has a live server-side consumer: create (T05/T08), read (T12),
  // update (T13) and publish (T15) — the set is now the full stored
  // vocabulary, because the publish-state operations shipped with T15.
  const API_KEY_ASSIGNABLE_SCOPES = Object.freeze(['share:create', 'share:read', 'share:update', 'share:publish']);

  router.put('/admin/apis/keys/:id/scopes', requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
    try {
      const scopes = normalizeApiKeyScopes(req.body?.scopes);

      if (!scopes || scopes.some(scope => !API_KEY_ASSIGNABLE_SCOPES.includes(scope))) {
        return res.status(400).json({
          success: false,
          error: `Scopes must be a list drawn from: ${API_KEY_ASSIGNABLE_SCOPES.join(', ')}`,
          code: 'invalid_scopes',
          retryable: false
        });
      }

      const updated = await pageRepository.updateApiKeyScopes(req.params.id, scopes);

      if (!updated) {
        return res.status(404).json({
          success: false,
          error: 'API key not found'
        });
      }

      pageRepository.createAuditLog({
        action: 'api_key.scopes',
        pageId: null,
        details: JSON.stringify({ apiKeyId: updated.id, scopes }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.json({
        success: true,
        apiKey: {
          id: updated.id,
          name: updated.name,
          key_prefix: updated.key_prefix,
          created_at: updated.created_at,
          last_used_at: updated.last_used_at,
          credential_version: toCredentialVersionString(updated.credential_version),
          scopes: [...parseApiKeyScopes(updated.scopes)],
          auto_grant_new_share_edit: updated.auto_grant_new_share_edit === true
        }
      });
    } catch (error) {
      console.error('Update API key scopes failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to update API key scopes'
      });
    }
  });

  // Auto-edit opt-in (T13): the owner chooses whether this Key
  // automatically receives read+update grants on the Shares IT creates
  // from now on. Enabling requires the Key to already hold the read and
  // update scopes (parent spec #24 §6: the option requires read/update
  // scopes) — otherwise the grants it would mint could never be used,
  // and the toggle would be a dead switch. The flag never applies
  // retroactively and never grants publish.
  router.put('/admin/apis/keys/:id/auto-grant', requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
    try {
      if (typeof req.body?.enabled !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'enabled must be a boolean',
          code: 'invalid_auto_grant',
          retryable: false
        });
      }

      const enabled = req.body.enabled;
      const existing = await pageRepository.getApiKeyById(req.params.id);

      if (!existing) {
        return res.status(404).json({
          success: false,
          error: 'API key not found'
        });
      }

      if (enabled) {
        const scopes = parseApiKeyScopes(existing.scopes);

        if (!scopes.includes('share:read') || !scopes.includes('share:update')) {
          return res.status(400).json({
            success: false,
            error: 'Auto-edit requires the share:read and share:update scopes',
            code: 'auto_grant_requires_scopes',
            retryable: false
          });
        }
      }

      const updated = await pageRepository.updateApiKeyAutoGrant(req.params.id, enabled);

      if (!updated) {
        return res.status(404).json({
          success: false,
          error: 'API key not found'
        });
      }

      pageRepository.createAuditLog({
        action: 'api_key.auto_grant',
        pageId: null,
        details: JSON.stringify({ apiKeyId: updated.id, enabled }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.json({
        success: true,
        apiKey: {
          id: updated.id,
          name: updated.name,
          key_prefix: updated.key_prefix,
          created_at: updated.created_at,
          last_used_at: updated.last_used_at,
          credential_version: toCredentialVersionString(updated.credential_version),
          scopes: [...parseApiKeyScopes(updated.scopes)],
          auto_grant_new_share_edit: updated.auto_grant_new_share_edit === true
        }
      });
    } catch (error) {
      console.error('Update API key auto-grant failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to update API key auto-grant'
      });
    }
  });

  // The owner's grant list for one Key (T12): which Shares this Key may
  // touch and with which resource permissions. Dashboard session only —
  // grants are owner-managed credential metadata, never exposed through
  // the v1 API itself.
  router.get('/admin/apis/keys/:id/grants', requireDashboardApiAdmin, async (req, res) => {
    try {
      const apiKey = await pageRepository.getApiKeyById(req.params.id);

      if (!apiKey) {
        return res.status(404).json({
          success: false,
          error: 'API key not found'
        });
      }

      const grants = await pageRepository.listShareGrants(req.params.id);

      return res.json({
        success: true,
        grants: grants.map(grant => ({
          shareId: grant.shareId,
          permissions: grant.permissions,
          shareExists: grant.shareExists,
          shareTitle: grant.shareTitle,
          createdAt: grant.createdAt,
          updatedAt: grant.updatedAt
        }))
      });
    } catch (error) {
      console.error('List API key grants failed:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to list API key grants'
      });
    }
  });

  // Grant (T12, update added by T13, publish added by T15): the owner
  // authorizes one Key on one Share. The dashboard grants the READ
  // permission, the UPDATE permission (which the grant model stores
  // together with read: an editor must be able to read back what it
  // edits) and — since the unpublish/republish endpoints shipped — the
  // PUBLISH permission, which is independent: it neither implies read
  // nor is implied by edit (parent spec #24 §6). Until T15 the publish
  // permission had no API behavior and a request naming it was refused
  // rather than stored as a dead switch. The repository applies the
  // Key-then-Share lock order inside the publishing gate.
  router.post('/admin/apis/keys/:id/grants', requireDashboardAdmin, parseSmallJson, requireDashboardCsrf, async (req, res) => {
    try {
      const shareId = typeof req.body?.shareId === 'string' ? req.body.shareId.trim() : '';
      const permissions = normalizeGrantPermissions(req.body?.permissions);

      if (!shareId || !permissions || !hasAnyGrantPermission(permissions)) {
        return res.status(400).json({
          success: false,
          error: 'A grant requires a shareId and at least one permission',
          code: 'invalid_grant',
          retryable: false
        });
      }

      const result = await pageRepository.grantShareAccess({
        keyId: req.params.id,
        shareId,
        permissions
      });

      if (result.status === 'key_not_found') {
        return res.status(404).json({ success: false, error: 'API key not found' });
      }

      if (result.status === 'share_not_found') {
        return res.status(404).json({ success: false, error: 'Share not found' });
      }

      pageRepository.createAuditLog({
        action: 'api_key.grant',
        pageId: shareId,
        details: JSON.stringify({
          apiKeyId: req.params.id,
          shareId,
          permissions: result.grant.permissions
        }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.status(result.created ? 201 : 200).json({
        success: true,
        created: result.created,
        grant: {
          shareId: result.grant.shareId,
          permissions: result.grant.permissions,
          createdAt: result.grant.createdAt,
          updatedAt: result.grant.updatedAt
        }
      });
    } catch (error) {
      console.error('Grant API key access failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to grant API key access'
      });
    }
  });

  // Revoke (T12): removes one Key's grant on one Share in the same
  // Key-then-Share lock order. The revocation audit is part of the
  // backup's revocation evidence: restoring an older backup can revive
  // a since-revoked grant, and the verify report names this event so the
  // owner can reconcile (see docs/backup-restore.md).
  router.delete('/admin/apis/keys/:id/grants/:shareId', requireDashboardAdmin, requireDashboardCsrf, async (req, res) => {
    try {
      const result = await pageRepository.revokeShareAccess({
        keyId: req.params.id,
        shareId: req.params.shareId
      });

      if (result.status === 'key_not_found') {
        return res.status(404).json({ success: false, error: 'API key not found' });
      }

      if (result.status === 'grant_not_found') {
        return res.status(404).json({
          success: false,
          error: 'Grant not found',
          code: 'grant_not_found',
          retryable: false
        });
      }

      pageRepository.createAuditLog({
        action: 'api_key.grant_revoke',
        pageId: req.params.shareId,
        details: JSON.stringify({ apiKeyId: req.params.id, shareId: req.params.shareId }),
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress
      }).catch((err) => { console.error('Audit log failed:', err); });

      return res.json({ success: true });
    } catch (error) {
      console.error('Revoke API key access failed:', error);
      if (respondIfPublishingGate(res, error)) {
        return;
      }
      return res.status(500).json({
        success: false,
        error: 'Failed to revoke API key access'
      });
    }
  });

  return router;
}

module.exports = {
  createAdminApiKeysRouter
};
