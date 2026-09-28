const { PrismaClient } = require('@prisma/client');
const globalForPrisma = global;
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production')
    { globalForPrisma.prisma = prisma;}
// ВАЖЛИВО: Переконайтеся, що експортується сам об'єкт prisma
module.exports = prisma;