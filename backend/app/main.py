from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
def home():
    return {"message": "PyDrop ta on Lil Cria"}