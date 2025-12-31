import express from 'express';
import connectDB from './config/db.js'
import productRoutes from './routes/ProductRoutes.js';
import authRoutes from './routes/AuthRoutes.js'
import KrogerRoutes from './routes/KrogerRoutes.js';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const port = 4000;
const app =  express();
app.use(cors({ origin: true, credentials: true }));

app.use(express.json());
app.use('/products', productRoutes);
app.use('/auth', authRoutes)
app.use('/kroger', KrogerRoutes);

connectDB();

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});