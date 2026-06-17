require('dotenv').config();

const fs = require('fs');
const qrcode = require('qrcode-terminal');

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

(async () => {
    const client = new TelegramClient(
        new StringSession(''),
        apiId,
        apiHash,
        {
            connectionRetries: 5,
        }
    );

    await client.connect();

    console.log('✅ Подключились');

    const user = await client.signInUserWithQrCode(
        {
            apiId,
            apiHash,
        },
        {
            qrCode: async ({ token, expires }) => {
                const encodedToken = token
                    .toString('base64')
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=/g, '');

                const qrUrl =
                    `tg://login?token=${encodedToken}`;

                console.log('\n📱 Telegram → Settings → Devices → Add Device\n');

                qrcode.generate(qrUrl, {
                    small: true,
                });

                console.log(
                    `QR действителен до ${new Date(expires * 1000).toLocaleString()}`
                );
            },
        }
    );

    console.log('✅ Авторизовано как:');
    console.log(user);

    const session = client.session.save();

    fs.writeFileSync('session.txt', session);

    console.log('\n💾 session.txt сохранён');
    console.log(session);

    await client.disconnect();
})();