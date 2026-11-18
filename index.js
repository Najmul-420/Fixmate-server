import { MongoClient } from 'mongodb';
import express from "express";
import 'dotenv/config';
import cors from "cors"
const PORT = process.env.PORT || 5000;
const app = express();


app.use(cors());
app.use(express.json());




const client = new MongoClient(`mongodb://${process.env.DB_USER }:${process.env.DB_PASSWORD }@ac-r3m4yny-shard-00-00.dosk1jp.mongodb.net:27017,ac-r3m4yny-shard-00-01.dosk1jp.mongodb.net:27017,ac-r3m4yny-shard-00-02.dosk1jp.mongodb.net:27017/?ssl=true&replicaSet=atlas-5op1qh-shard-0&authSource=admin`);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const db = await connectToMongoDB();


app.get('/',(req ,res)=>{
    res.send("Hello FixMate")
})

app.get("/service" ,(req ,res) =>{
    res.send('Service page')
})

app.listen(PORT,()=>{
    console.log(`server is running on port ${PORT}`)
})