require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:4200",
    methods: ["GET", "POST"]
  }
});

app.use(cors());

// Configurar middleware para el manejo de JSON
app.use(express.json());

// URI de conexión a MongoDB Atlas. Extraer de forma segura
const uri = process.env.MONGODB_URI;

console.log('Connecting to MongoDB:', uri);

// Opciones de configuración para el cliente de MongoDB
const mongoOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
};

mongoose.connect(uri, mongoOptions)
  .then(() => {
    console.log('Connected to MongoDB');
  })
  .catch((error) => {
    console.error('Error connecting to MongoDB:', error);
  });

const questions = [];
const answers = [];

const questionSchema = new mongoose.Schema({
  question: String,
  options: [String],
  answer: Number
});
const Question = mongoose.model('Question', questionSchema);

const createdRooms = new Set();
const roomUsers = {};

io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('createRoom', (roomId) => {
    createdRooms.add(roomId);
    socket.join(roomId);
    console.log(`Client created and joined room: ${roomId}`);
    if (!roomUsers[roomId]) {
      roomUsers[roomId] = 0;
    }
    io.to(roomId).emit('UserJoined', { roomId, joinedUsers: roomUsers[roomId] || 0 });
  });

  socket.on('joinRoom', (roomId) => {
    if (createdRooms.has(roomId)) {
      socket.join(roomId);
      if (!roomUsers[roomId]) {
        roomUsers[roomId] = 0;
      }
      roomUsers[roomId]++;
      console.log(`Client joined room: ${roomId}`);
      io.to(roomId).emit('UserJoined', { roomId, joinedUsers: roomUsers[roomId] });
    } else {
      console.log(`Room not found: ${roomId}`);
      socket.emit('error', 'Room not found');
    }
  });

  socket.on('joinQuiz', async () => {
    await handleJoinQuiz(socket);
  });

  socket.on('startQuiz', (roomId) => {
    if (createdRooms.has(roomId)) {
      roomUsers[roomId] = { currentQuestionIndex: 0 };
      startQuizTimer(roomId);
    } else {
      socket.emit('error', 'Room not found');
    }
  }); 

  socket.on('submitAnswer', (data) => {
    handleSubmitAnswer(socket, data);
  });

  /*socket.on('disconnect', () => {
    console.log('Client disconnected 1');
    const rooms = Array.from(socket.rooms).filter(room => room !== socket.id);
    console.log('Rooms the client was in:', rooms);
    rooms.forEach(roomId => {
      if (roomUsers[roomId] !== undefined) {
        roomUsers[roomId]--;
        if (roomUsers[roomId] <= 0) {
          delete roomUsers[roomId];
        } else {
          console.log('Client left room:', roomId);
          io.to(roomId).emit('UserLeft', { roomId, joinedUsers: roomUsers[roomId] });
        }
      } else {
        console.log('No users in room:', roomId);
      }
    });
    console.log('Client disconnected 2');
  });*/

  socket.on('disconnect', () => {
    console.log('Total users in room:', roomUsers);
    // Obtener el id de la sala a la que se unió el cliente
    const room = Array.from(socket.rooms).find(room => room == socket.id);
    // Reducir el número de usuarios en la sala
    if (roomUsers[room] !== undefined) {
      roomUsers[room]--;
      // Si no hay más usuarios en la sala, eliminar la sala
      if (roomUsers[room] <= 0) {
        delete roomUsers[room];
      } else {
        // Informar a los demás usuarios de la sala que un usuario ha salido
        io.to(room).emit('UserLeft', { joinedUsers: roomUsers[room] });
      }
    }
    else
      console.log('No users in room:', room);
  });

});

io.of("/").adapter.on("join-room", (room, id) => {
  console.log(`socket ${id} has joined room ${room}`);
});

io.of("/").adapter.on("leave-room", (room, id) => {
  console.log('Joined users:', roomUsers[room]);
  io.to(room).emit('UserLeft', { joinedUsers: roomUsers[room] });
  //console.log(`socket ${id} has left room ${room}`);
});

async function handleJoinQuiz(socket) {
  try {
    console.log('Client joined quiz, fetching questions from MongoDB');
    const fetchedQuestions = await Question.find({}, { answer: 0 });
    console.log('Questions fetched:', fetchedQuestions.length);
    questions.length = 0;
    questions.push(...fetchedQuestions);

    const fetchedAnswers = await Question.find({}, { _id: 1, answer: 1 });
    answers.length = 0;
    answers.push(...fetchedAnswers);

    socket.emit('quizQuestions', questions);
    console.log('Answers fetched:', answers.length);
  } catch (error) {
    console.error('Error fetching questions from MongoDB:', error);
    socket.emit('error', 'Error fetching questions from the database');
  }
}

const timers = {};

function startQuizTimer(roomId) {
  console.log('Starting quiz timer');
  let timeLeft = 6;
  timers[roomId] = setInterval(() => {
    if (timeLeft > 0) {
      timeLeft--;
      io.to(roomId).emit('quizTimerUpdate', timeLeft);
    } else {
      clearInterval(timers[roomId]);
      nextQuestion(roomId);
    }
  }, 1000);
  io.to(roomId).emit('quizStarted');
}

function nextQuestion(roomId) {
  const room = roomUsers[roomId];
  if (room && room.currentQuestionIndex < questions.length - 1) {
    room.currentQuestionIndex++;
    io.to(roomId).emit('nextQuestion', room.currentQuestionIndex);
    startQuizTimer(roomId);  // Restart the timer for the next question
  } else {
    io.to(roomId).emit('quizEnded');
  }
}

function handleSubmitAnswer(socket, data) {
  try {

    const { questionId, selectedOption, roomId } = data;

    const question = questions.find(q => q._id.toString() === questionId);
    if (!question) {
      console.log('Question not found:', questionId);
      socket.emit('answerResult', { success: false, message: 'Question not found' });
      return;
    }
    if (roomId === undefined) {
      console.log('Team ID not provided');
      socket.emit('answerResult', { success: false, message: 'Team ID not provided' });
      return;
    }
    
    console.log('Client submitted answer:', questionId, selectedOption);

    const correctAnswer = answers.find(a => a._id.toString() === questionId);
    const isCorrect = question.options[correctAnswer.answer] === selectedOption;

    if (isCorrect) {
      console.log('Client answered correctly: roomId-' + roomId);
    } else {
      console.log('Client answered incorrectly : roomId-' + roomId);
    }

    io.to(roomId).emit('answerResult', { success: true, correct: isCorrect });
  } catch (error) {
    console.error('Error processing answer:', error);
    socket.emit('error', 'Error processing answer');
  }
}

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});