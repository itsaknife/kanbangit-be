import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export default {
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
  },
};
