/**
 * WASENDER Anti-Ban Protection Suite
 * Essential algorithms to prevent WhatsApp spam detection and account flagging.
 */

// 1. Zero-Width Space Injection
// Randomizes the payload checksum invisibly so WhatsApp servers do not flag template mass-broadcasting
function randomizeText(text) {
    if (!text) return '';
    const zeroWidthSpace = '\u200B';
    const splitText = text.split('');
    const randomPos = Math.floor(Math.random() * splitText.length);
    splitText.splice(randomPos, 0, zeroWidthSpace);
    return splitText.join('');
}

// 2. Format & Sanitize Mobile Number
function formatMobileNumber(mobile) {
    if (!mobile) return null;
    const cleaned = String(mobile).replace(/\D/g, '');
    if (cleaned.length < 10) return null;
    if (cleaned.startsWith('91') && cleaned.length >= 12) return cleaned;
    if (cleaned.length === 10) return '91' + cleaned;
    return cleaned;
}

// 3. Human Simulation: Realistic Typing Indicator
async function simulateTyping(client, targetChatId, minMs = 2500, maxMs = 5000) {
    try {
        const chat = await client.getChatById(targetChatId);
        if (!chat) return;

        const typingDuration = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
        await chat.sendStateTyping();

        await new Promise(resolve => setTimeout(resolve, typingDuration));

        await chat.clearState();
    } catch (err) {
        // If chat doesn't exist yet or typing simulation fails, proceed gracefully
    }
}

// 4. Contact LID Identifier Resolution
// Pre-fetches contact to map phone number -> LID to prevent "Lid is missing in chat table" errors
async function resolveContactIdentifier(client, phone) {
    const defaultChatId = `${phone}@c.us`;
    try {
        const contact = await client.getContactById(defaultChatId);
        if (contact && contact.id && contact.id._serialized) {
            return contact.id._serialized;
        }
    } catch (err) {
        // Fallback to default
    }
    return defaultChatId;
}

// 5. Random Delay Helper between consecutive sends
function getJitterDelay(minMs = 8000, maxMs = 12000) {
    return Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
}

module.exports = {
    randomizeText,
    formatMobileNumber,
    simulateTyping,
    resolveContactIdentifier,
    getJitterDelay
};
