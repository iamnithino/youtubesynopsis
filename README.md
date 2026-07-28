# youtubesynopsis
# 🎥 AI Video Synopsis

An AI-powered web application that transforms YouTube videos into intelligent summaries, key insights, and structured content using Large Language Models (LLMs). The platform enables users to quickly understand long-form video content without watching the entire video.

---

## ✨ Features

- 🔗 Summarize any YouTube video using its URL
- 🤖 AI-generated summaries powered by OpenAI
- 📝 Multiple summary modes
- 🎯 Key points extraction
- 📖 Chapter-wise breakdown
- 🎬 Transcript & caption processing
- 📊 Modern and responsive UI
- ⚡ Fast API-based backend
- ☁️ Cloud deployment with Vercel and Render

---

## 🛠 Tech Stack

### Frontend
- React
- TypeScript
- Vite
- Tailwind CSS
- Framer Motion

### Backend
- FastAPI
- Python
- Uvicorn

### AI
- OpenAI API

### Video Processing
- YouTube Transcript API
- Caption Service

### Deployment
- Vercel
- Render
- GitHub

---

## 📂 Project Structure

```text
youtubesynopsis/
│
├── frontend/            # React + Vite Frontend
├── backend/             # FastAPI Backend
├── backend-node/        # Node.js Services
├── caption-service/     # Caption Processing
│
├── .gitignore
├── README.md
├── render.yaml
└── start-local.cmd
```

---

## 🚀 Getting Started

### Clone Repository

```bash
git clone https://github.com/iamnithino/youtubesynopsis.git
cd youtubesynopsis
```

---

## Backend Setup

```bash
cd backend

python -m venv venv
```

### Activate Environment

Windows

```bash
venv\Scripts\activate
```

Linux / macOS

```bash
source venv/bin/activate
```

Install dependencies

```bash
pip install -r requirements.txt
```

Run the backend

```bash
uvicorn main:app --reload
```

---

## Frontend Setup

```bash
cd frontend

npm install

npm run dev
```

---

## Environment Variables

Backend

```env
OPENAI_API_KEY=your_api_key
MODEL=gpt-4o-mini
```

Frontend

```env
VITE_API_URL=http://localhost:8000
```

---

## ⚙️ How It Works

1. User enters a YouTube video URL.
2. The backend validates the URL.
3. The transcript is extracted.
4. Caption Service processes the transcript.
5. OpenAI generates an AI-powered summary.
6. The response is displayed in the frontend.

---

## 📦 Deployment

### Frontend

- Vercel

### Backend

- Render

---

## 📈 Architecture

```text
User
   │
   ▼
React Frontend
   │
REST API
   │
   ▼
FastAPI Backend
   │
   ├── Caption Service
   ├── Transcript Extraction
   └── OpenAI API
            │
            ▼
      AI Generated Summary
            │
            ▼
      Response to Frontend
```

---

## 🎯 Business Value

AI Video Synopsis helps users save time by converting lengthy YouTube videos into concise, structured summaries. It is designed for students, professionals, researchers, and content creators who want quick access to important information.

---

## 🔮 Future Improvements

- Video comparison
- PPT generation
- PDF export
- DOCX export
- Multi-language summaries
- Voice narration
- User authentication
- History dashboard

---

## 👨‍💻 Author

**Oruganti Nithin Reddy**

GitHub: https://github.com/iamnithino

---

## 📄 License

This project is developed for educational and assessment purposes.
