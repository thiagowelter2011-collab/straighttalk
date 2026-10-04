# Ligar a mensalidade (Mercado Pago)

Enquanto o Render não tiver a chave `MP_ACCESS_TOKEN`, criar conta no StraightTalk é grátis.
Depois de ligar:

- contas novas pagam a mensalidade para usar (Pix, cartão ou boleto, pelo Mercado Pago);
- cada pagamento aprovado libera 30 dias; pagar antes de vencer soma mais 30 dias;
- quando vence, o app mostra a tela de pagamento até a pessoa renovar;
- contas criadas antes de ligar a cobrança continuam grátis.

## Passo a passo

1. Crie (ou entre na) sua conta em https://www.mercadopago.com.br com seus dados e o banco onde quer receber.
2. Abra https://www.mercadopago.com.br/developers/panel/app e clique em **Criar aplicação**.
   - Nome: StraightTalk
   - Tipo de solução: **Pagamentos online**, produto **Checkout Pro**.
3. Na aplicação, abra **Credenciais de produção** e copie o **Access Token** (começa com `APP_USR-`).
   Essa chave é secreta: não mande em chat nem coloque no código.
4. No Render, abra o serviço **straighttalk** > **Environment** > **Add Environment Variable**:
   - `MP_ACCESS_TOKEN` = o Access Token copiado
   - `MONTHLY_PRICE` = valor da mensalidade em reais, por exemplo `10` ou `14.90` (opcional; o padrão é 10)
5. Clique em **Save, rebuild and deploy**.

O site avisa o Mercado Pago do endereço de retorno sozinho (o Render informa o endereço em `RENDER_EXTERNAL_URL`).
Se o aviso automático falhar, o botão **Já paguei** confere direto no Mercado Pago.

Para desligar a cobrança, apague `MP_ACCESS_TOKEN` no Render: todo mundo volta a usar de graça.
