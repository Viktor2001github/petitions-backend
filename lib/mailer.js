const Mailjet = require('node-mailjet');

const mailjet = Mailjet.apiConnect(
  process.env.MAILJET_API_KEY,
  process.env.MAILJET_SECRET_KEY
);

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://petitions-frontend.vercel.app';
const SENDER_EMAIL = process.env.EMAIL_USER || 'vvs2001.viktor@gmail.com';
const SENDER_NAME = 'Е-Петиції';

// 1. Сповіщення адміна
async function sendAdminNotification(petition) {
  return await mailjet.post('send', { version: 'v3.1' }).request({
    Messages: [
      {
        From: { Email: SENDER_EMAIL, Name: SENDER_NAME },
        To: [{ Email: 'vvs2001.viktor@gmail.com' }],
        Subject: `Петиція №${petition.id} набрала необхідну кількість голосів!`,
        HTMLPart: `
          <h2>Петиція потребує розгляду</h2>
          <p><strong>Назва:</strong> ${petition.title}</p>
          <p><strong>Категорія:</strong> ${petition.category || 'Не вказано'}</p>
          <p>Петиція зібрала необхідну кількість підписів і перейшла в статус <strong>REVIEW</strong>.</p>
          <hr />
          <p><a href="${FRONTEND_URL}" style="background: #19436e; color: #fff; padding: 10px 15px; text-decoration: none; border-radius: 5px; display: inline-block;">Перейти до петицій</a></p>
        `,
      },
    ],
  });
}

// 2. Сповіщення користувача
async function sendEmailNotification(to, subject, text) {
  return await mailjet.post('send', { version: 'v3.1' }).request({
    Messages: [
      {
        From: { Email: SENDER_EMAIL, Name: SENDER_NAME },
        To: [{ Email: to }],
        Subject: subject,
        TextPart: text,
      },
    ],
  });
}

// 3. Відновлення пароля
async function sendResetPasswordEmail(to, resetUrl) {
  return await mailjet.post('send', { version: 'v3.1' }).request({
    Messages: [
      {
        From: { Email: SENDER_EMAIL, Name: SENDER_NAME },
        To: [{ Email: to }],
        Subject: 'Відновлення пароля | Е-Петиції',
        HTMLPart: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
            <h2 style="color: #19436e;">Відновлення пароля</h2>
            <p>Ви отримали цей лист, тому що ми отримали запит на скидання пароля для вашого акаунту.</p>
            <p>Для того, щоб задати новий пароль, натисніть на кнопку нижче:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" style="background-color: #19436e; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
                Змінити пароль
              </a>
            </div>
            <p style="color: #666; font-size: 14px;">Посилання дійсна протягом <strong>30 хвилин</strong>.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
            <p style="color: #999; font-size: 12px;">Якщо ви не надсилали цей запит, просто проігноруйте цей лист.</p>
          </div>
        `,
      },
    ],
  });
}

module.exports = { 
  sendAdminNotification, 
  sendEmailNotification,
  sendResetPasswordEmail
};