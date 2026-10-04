// Mensalidade pelo Mercado Pago (Checkout Pro: Pix, cartão ou boleto). Cada pagamento aprovado libera 30 dias.
// Desligada enquanto MP_ACCESS_TOKEN não estiver configurado: aí criar conta continua grátis.
//   MP_ACCESS_TOKEN  chave "Access Token" de produção do Mercado Pago (só no Render, nunca no código)
//   MONTHLY_PRICE    valor da mensalidade em reais (padrão 10)
//   PUBLIC_URL       endereço do site (no Render vem sozinho em RENDER_EXTERNAL_URL)

function createPayments({
  token = process.env.MP_ACCESS_TOKEN,
  price = Number(process.env.MONTHLY_PRICE) || 10,
  apiBase = process.env.MP_API_BASE || 'https://api.mercadopago.com',
  publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '',
} = {}) {
  price = Math.round(price * 100) / 100;
  const ref = (userId) => `user-${userId}`;

  async function mp(method, path, body) {
    const res = await fetch(apiBase + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Mercado Pago respondeu ${res.status}: ${data.message || ''}`);
    return data;
  }

  // Só vale pagamento aprovado, desta conta, em reais e no valor certo
  function validFor(payment, userId) {
    return payment && payment.status === 'approved' && payment.external_reference === ref(userId) &&
      payment.currency_id === 'BRL' && Number(payment.transaction_amount) >= price;
  }

  return {
    enabled: !!token,
    price,

    // Link da página de pagamento do Mercado Pago para esta conta
    async checkout(user) {
      const back = publicUrl ? `${publicUrl.replace(/\/$/, '')}/?pagamento=volta` : undefined;
      const pref = await mp('POST', '/checkout/preferences', {
        items: [{ id: 'mensalidade', title: 'StraightTalk: 30 dias', quantity: 1, unit_price: price, currency_id: 'BRL' }],
        external_reference: ref(user.id),
        statement_descriptor: 'STRAIGHTTALK',
        ...(back ? { back_urls: { success: back, pending: back, failure: back }, auto_return: 'approved' } : {}),
        ...(publicUrl ? { notification_url: `${publicUrl.replace(/\/$/, '')}/api/payment/webhook` } : {}),
      });
      return pref.init_point;
    },

    // Pagamentos aprovados desta conta (para o botão "Já paguei" e a volta do Mercado Pago)
    async findApproved(userId) {
      const data = await mp('GET', `/v1/payments/search?external_reference=${encodeURIComponent(ref(userId))}&status=approved&sort=date_created&criteria=desc&limit=30`);
      return (data.results || []).filter((p) => validFor(p, userId)).map((p) => ({ userId, paymentId: String(p.id), amount: Number(p.transaction_amount) }));
    },

    // Aviso do Mercado Pago: o pagamento é sempre conferido direto na API deles, nunca pelo que veio no aviso
    async fromWebhook(paymentId) {
      if (!/^\d{1,20}$/.test(String(paymentId))) return null;
      const p = await mp('GET', `/v1/payments/${paymentId}`);
      const m = /^user-(\d+)$/.exec(p.external_reference || '');
      const userId = m && Number(m[1]);
      return userId && validFor(p, userId) ? { userId, paymentId: String(p.id), amount: Number(p.transaction_amount) } : null;
    },
  };
}

module.exports = { createPayments };
