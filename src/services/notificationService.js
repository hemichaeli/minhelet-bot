const { logger } = require('./logger');

// ============================================================
// מינהלת Notification Service - SSE-based real-time alerts
// ============================================================
// Events: new_lead, new_message, hot_opportunity, system_alert
// Usage: notificationService.broadcast('new_lead', { name, phone, budget })
// ============================================================

class NotificationService {
  constructor() {
    this.clients = new Map();   // clientId -> res
    this.history = [];          // last 100 notifications
    this.maxHistory = 100;
    this.totalBroadcast = 0;
  }

  addClient(clientId, res) {
    this.clients.set(clientId, res);
    logger.info(`[SSE] Client connected: ${clientId}. Total: ${this.clients.size}`);

    // Send last 10 notifications to new client immediately
    const recent = this.history.slice(-10);
    if (recent.length > 0) {
      recent.forEach(n => this._sendToClient(res, n));
    }

    // Welcome ping
    try {
      res.write(': connected\n\n');
    } catch (e) { /* ignore */ }
  }

  removeClient(clientId) {
    this.clients.delete(clientId);
    logger.info(`[SSE] Client disconnected: ${clientId}. Total: ${this.clients.size}`);
  }

  _sendToClient(res, notification) {
    try {
      res.write(`data: ${JSON.stringify(notification)}\n\n`);
    } catch (e) {
      // Client disconnected - will be cleaned up on 'close' event
    }
  }

  broadcast(type, data = {}) {
    const notification = {
      id: ++this.totalBroadcast,
      type,
      data,
      timestamp: new Date().toISOString(),
      label: this._getLabel(type)
    };

    this.history.push(notification);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    let sent = 0;
    const deadClients = [];

    this.clients.forEach((res, clientId) => {
      try {
        this._sendToClient(res, notification);
        sent++;
      } catch (e) {
        deadClients.push(clientId);
      }
    });

    // Cleanup dead connections
    deadClients.forEach(id => this.clients.delete(id));

    logger.info(`[SSE] Broadcast type="${type}" to ${sent}/${this.clients.size} clients`);
    return notification;
  }

  _getLabel(type) {
    const labels = {
      new_lead:        '🔥 ליד חדש',
      new_message:     '💬 הודעה חדשה',
      hot_opportunity: '⚡ הזדמנות חמה',
      system_alert:    '🔔 התראת מערכת',
      new_complex:     '🏗️ מתחם חדש',
      morning_report:  '🌅 דוח בוקר מוכן',
      export_ready:    '📥 ייצוא מוכן',
      whatsapp:        '📱 וואטסאפ',
    };
    return labels[type] || '📌 עדכון';
  }

  getHistory(limit = 50) {
    return this.history.slice(-limit);
  }

  getStats() {
    return {
      connected_clients: this.clients.size,
      total_notifications: this.history.length,
      total_broadcast: this.totalBroadcast,
      uptime_since: new Date(Date.now() - process.uptime() * 1000).toISOString()
    };
  }

  // Helper: broadcast from other services without full import
  newLead(lead) {
    return this.broadcast('new_lead', {
      name: lead.name || 'ליד חדש',
      phone: lead.phone,
      budget: lead.budget,
      source: lead.source || 'אתר'
    });
  }

  newMessage(msg) {
    return this.broadcast('new_message', {
      from: msg.from || msg.sender,
      preview: (msg.content || msg.body || '').substring(0, 80),
      channel: msg.channel || 'whatsapp'
    });
  }

  hotOpportunity(complex) {
    return this.broadcast('hot_opportunity', {
      name: complex.name,
      city: complex.city,
      iai: complex.iai_score,
      reason: complex.reason || 'ציון IAI גבוה'
    });
  }
}

// Singleton export
module.exports = new NotificationService();
