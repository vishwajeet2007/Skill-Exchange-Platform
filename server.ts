import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = 3000;
const DB_PATH = path.join(process.cwd(), 'src', 'db.json');

// Helper to read database
function readDB() {
  try {
    const data = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading DB, using empty template', err);
    return {
      users: [],
      skills: [],
      exchange_requests: [],
      sessions: [],
      chats: [],
      messages: [],
      reviews: [],
      notifications: []
    };
  }
}

// Helper to write database
function writeDB(data: any) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing DB', err);
  }
}

// Lazy load Gemini AI Client
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && apiKey !== 'MY_GEMINI_API_KEY') {
      aiClient = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
    }
  }
  return aiClient;
}

app.use(express.json());

// ================= AUTH ENDPOINTS =================

// Register
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, phone, bio, location, experienceLevel, skillsOffered, skillsWanted } = req.body;
  const db = readDB();

  if (db.users.some((u: any) => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'User with this email already exists' });
  }

  const newUser = {
    id: 'u_' + Date.now(),
    name,
    email,
    password,
    phone: phone || '',
    bio: bio || '',
    location: location || '',
    avatar: `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(name)}`,
    experienceLevel: experienceLevel || 'Beginner',
    skillsOffered: skillsOffered || [],
    skillsWanted: skillsWanted || [],
    role: 'user',
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);

  // Sync user's offered skills into the skills collection too
  if (skillsOffered && skillsOffered.length > 0) {
    skillsOffered.forEach((skillName: string, index: number) => {
      db.skills.push({
        id: `s_${Date.now()}_${index}`,
        name: skillName,
        category: 'General',
        description: `Offered by ${name}. Get in touch to learn this skill!`,
        level: experienceLevel || 'Intermediate',
        userId: newUser.id,
        userName: name,
        createdAt: new Date().toISOString()
      });
    });
  }

  writeDB(db);
  const { password: _, ...safeUser } = newUser;
  res.status(201).json(safeUser);
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const db = readDB();

  const user = db.users.find(
    (u: any) => u.email.toLowerCase() === email.toLowerCase() && u.password === password
  );

  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const { password: _, ...safeUser } = user;
  res.json(safeUser);
});

// Forgot Password
app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  const db = readDB();
  const user = db.users.find((u: any) => u.email.toLowerCase() === email.toLowerCase());

  if (!user) {
    return res.status(404).json({ error: 'No account found with this email' });
  }

  // Generate mock recovery instructions
  res.json({
    message: `Password reset instructions sent successfully. (Developer Mode: Password is "${user.password}")`
  });
});

// ================= SKILLS ENDPOINTS =================

// Get all skills with search & filter parameters
app.get('/api/skills', (req, res) => {
  const { q, category, location } = req.query;
  const db = readDB();
  let results = [...db.skills];

  // Map avatars for matching skill owner
  results = results.map(s => {
    const owner = db.users.find((u: any) => u.id === s.userId);
    return { ...s, userAvatar: owner?.avatar || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150' };
  });

  if (q) {
    const queryStr = String(q).toLowerCase();
    results = results.filter(s =>
      s.name.toLowerCase().includes(queryStr) ||
      s.description.toLowerCase().includes(queryStr) ||
      s.userName.toLowerCase().includes(queryStr)
    );
  }

  if (category && category !== 'All') {
    results = results.filter(s => s.category === category);
  }

  if (location) {
    const locStr = String(location).toLowerCase();
    results = results.filter(s => {
      const owner = db.users.find((u: any) => u.id === s.userId);
      return owner && owner.location.toLowerCase().includes(locStr);
    });
  }

  res.json(results);
});

// Add a new skill
app.post('/api/skills', (req, res) => {
  const { name, category, description, level, userId } = req.body;
  const db = readDB();

  const user = db.users.find((u: any) => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const newSkill = {
    id: 's_' + Date.now(),
    name,
    category,
    description,
    level,
    userId,
    userName: user.name,
    createdAt: new Date().toISOString()
  };

  db.skills.push(newSkill);

  // Add to user's local offered list if not present
  if (!user.skillsOffered.includes(name)) {
    user.skillsOffered.push(name);
  }

  writeDB(db);
  res.status(201).json(newSkill);
});

// Edit a skill
app.put('/api/skills/:id', (req, res) => {
  const { id } = req.params;
  const { name, category, description, level } = req.body;
  const db = readDB();

  const index = db.skills.findIndex((s: any) => s.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Skill not found' });
  }

  db.skills[index] = {
    ...db.skills[index],
    name,
    category,
    description,
    level
  };

  writeDB(db);
  res.json(db.skills[index]);
});

// Delete a skill
app.delete('/api/skills/:id', (req, res) => {
  const { id } = req.params;
  const db = readDB();

  const skill = db.skills.find((s: any) => s.id === id);
  if (!skill) {
    return res.status(404).json({ error: 'Skill not found' });
  }

  db.skills = db.skills.filter((s: any) => s.id !== id);

  // Remove from user's list
  const user = db.users.find((u: any) => u.id === skill.userId);
  if (user) {
    user.skillsOffered = user.skillsOffered.filter((n: string) => n !== skill.name);
  }

  writeDB(db);
  res.json({ message: 'Skill deleted successfully' });
});

// ================= USER ENDPOINTS =================

app.get('/api/users/:id', (req, res) => {
  const db = readDB();
  const user = db.users.find((u: any) => u.id === req.params.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  const { password, ...safeUser } = user;
  res.json(safeUser);
});

app.put('/api/users/:id', (req, res) => {
  const db = readDB();
  const index = db.users.findIndex((u: any) => u.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { name, phone, bio, location, experienceLevel, skillsOffered, skillsWanted } = req.body;

  db.users[index] = {
    ...db.users[index],
    name: name || db.users[index].name,
    phone: phone || db.users[index].phone,
    bio: bio || db.users[index].bio,
    location: location || db.users[index].location,
    experienceLevel: experienceLevel || db.users[index].experienceLevel,
    skillsOffered: skillsOffered || db.users[index].skillsOffered,
    skillsWanted: skillsWanted || db.users[index].skillsWanted
  };

  writeDB(db);
  const { password, ...safeUser } = db.users[index];
  res.json(safeUser);
});

// ================= REQUESTS ENDPOINTS =================

// Get requests involving a user (either sender or receiver)
app.get('/api/requests', (req, res) => {
  const { userId } = req.query;
  const db = readDB();

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const results = db.exchange_requests.filter(
    (r: any) => r.senderId === userId || r.receiverId === userId
  );

  res.json(results);
});

// Send exchange request
app.post('/api/requests', (req, res) => {
  const { senderId, receiverId, skillOfferedId, skillOfferedName, skillWantedId, skillWantedName } = req.body;
  const db = readDB();

  const sender = db.users.find((u: any) => u.id === senderId);
  const receiver = db.users.find((u: any) => u.id === receiverId);

  if (!sender || !receiver) {
    return res.status(404).json({ error: 'Sender or Receiver not found' });
  }

  const newRequest = {
    id: 'req_' + Date.now(),
    senderId,
    senderName: sender.name,
    receiverId,
    receiverName: receiver.name,
    skillOfferedId,
    skillOfferedName,
    skillWantedId,
    skillWantedName,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  db.exchange_requests.push(newRequest);

  // Send system notification to receiver
  db.notifications.push({
    id: 'n_' + Date.now(),
    userId: receiverId,
    text: `New Skill Exchange request from ${sender.name} offering "${skillOfferedName}" in exchange for your "${skillWantedName}"!`,
    type: 'request',
    read: false,
    createdAt: new Date().toISOString()
  });

  writeDB(db);
  res.status(201).json(newRequest);
});

// Accept/Reject/Cancel request
app.patch('/api/requests/:id', (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'accepted', 'rejected', 'cancelled'
  const db = readDB();

  const index = db.exchange_requests.findIndex((r: any) => r.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Request not found' });
  }

  const request = db.exchange_requests[index];
  request.status = status;

  if (status === 'accepted') {
    // Create notification for sender
    db.notifications.push({
      id: 'n_' + Date.now() + '_s',
      userId: request.senderId,
      text: `${request.receiverName} accepted your Skill Exchange request! Go ahead and book a session now.`,
      type: 'request',
      read: false,
      createdAt: new Date().toISOString()
    });

    // Automatically create a private chat thread if not already existing
    const existingChat = db.chats.find(
      (c: any) =>
        (c.user1Id === request.senderId && c.user2Id === request.receiverId) ||
        (c.user1Id === request.receiverId && c.user2Id === request.senderId)
    );

    if (!existingChat) {
      db.chats.push({
        id: `chat_${request.senderId}_${request.receiverId}`,
        user1Id: request.senderId,
        user2Id: request.receiverId
      });

      // System greeting message
      db.messages.push({
        id: 'm_' + Date.now(),
        senderId: 'system',
        receiverId: request.senderId,
        message: `System: Chat room initialized! You can now coordinate details with ${request.receiverName}.`,
        timestamp: new Date().toISOString(),
        read: false
      });
    }
  } else if (status === 'rejected') {
    db.notifications.push({
      id: 'n_' + Date.now() + '_r',
      userId: request.senderId,
      text: `${request.receiverName} declined your skill exchange request for "${request.skillOfferedName}".`,
      type: 'request',
      read: false,
      createdAt: new Date().toISOString()
    });
  }

  writeDB(db);
  res.json(request);
});

// ================= BOOKINGS & SESSIONS ENDPOINTS =================

// Get sessions involving user
app.get('/api/sessions', (req, res) => {
  const { userId } = req.query;
  const db = readDB();

  let results = [...db.sessions];

  // Match corresponding request details to enrich response
  results = results.map(session => {
    const request = db.exchange_requests.find((r: any) => r.id === session.requestId);
    return { ...session, request };
  });

  if (userId) {
    results = results.filter(s => s.request && (s.request.senderId === userId || s.request.receiverId === userId));
  }

  res.json(results);
});

// Create booking session
app.post('/api/sessions', (req, res) => {
  const { requestId, date, time, type, locationDetails, notes } = req.body;
  const db = readDB();

  const request = db.exchange_requests.find((r: any) => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: 'Skill exchange request not found' });
  }

  const newSession = {
    id: 'b_' + Date.now(),
    requestId,
    date,
    time,
    type,
    locationDetails: locationDetails || (type === 'online' ? 'https://meet.google.com/mock-link' : 'Main Library Room 4B'),
    status: 'scheduled',
    notes,
    completed: false,
    hasCertificate: false,
    createdAt: new Date().toISOString()
  };

  db.sessions.push(newSession);

  // Notify both parties
  const notifyList = [request.senderId, request.receiverId];
  notifyList.forEach(uid => {
    db.notifications.push({
      id: 'n_' + Date.now() + '_' + uid,
      userId: uid,
      text: `New exchange session scheduled on ${date} at ${time} (${type})!`,
      type: 'session',
      read: false,
      createdAt: new Date().toISOString()
    });
  });

  writeDB(db);
  res.status(201).json({ ...newSession, request });
});

// Update session / Complete session & Generate Certificate
app.patch('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  const { status, completed, hasCertificate } = req.body;
  const db = readDB();

  const index = db.sessions.findIndex((s: any) => s.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Session not found' });
  }

  db.sessions[index] = {
    ...db.sessions[index],
    status: status !== undefined ? status : db.sessions[index].status,
    completed: completed !== undefined ? completed : db.sessions[index].completed,
    hasCertificate: hasCertificate !== undefined ? hasCertificate : db.sessions[index].hasCertificate
  };

  if (completed === true) {
    db.sessions[index].status = 'completed';
    // Notify users
    const request = db.exchange_requests.find((r: any) => r.id === db.sessions[index].requestId);
    if (request) {
      [request.senderId, request.receiverId].forEach(uid => {
        db.notifications.push({
          id: 'n_' + Date.now() + '_' + uid,
          userId: uid,
          text: `Your skill exchange session is completed! You can now write a review and check your completion certificate!`,
          type: 'session',
          read: false,
          createdAt: new Date().toISOString()
        });
      });
    }
  }

  writeDB(db);
  res.json(db.sessions[index]);
});

// ================= PRIVATE CHAT SYSTEM =================

// Get chat rooms lists with last message
app.get('/api/chats', (req, res) => {
  const { userId } = req.query;
  const db = readDB();

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const userChats = db.chats.filter((c: any) => c.user1Id === userId || c.user2Id === userId);

  const enrichedChats = userChats.map((c: any) => {
    const otherUserId = c.user1Id === userId ? c.user2Id : c.user1Id;
    const otherUser = db.users.find((u: any) => u.id === otherUserId);
    const messages = db.messages.filter(
      (m: any) =>
        (m.senderId === userId && m.receiverId === otherUserId) ||
        (m.senderId === otherUserId && m.receiverId === userId)
    );

    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

    return {
      id: c.id,
      otherUser: otherUser ? {
        id: otherUser.id,
        name: otherUser.name,
        avatar: otherUser.avatar,
        bio: otherUser.bio,
        location: otherUser.location
      } : null,
      lastMessage
    };
  });

  res.json(enrichedChats);
});

// Get message history in thread
app.get('/api/messages', (req, res) => {
  const { senderId, receiverId } = req.query;
  const db = readDB();

  const messages = db.messages.filter(
    (m: any) =>
      (m.senderId === senderId && m.receiverId === receiverId) ||
      (m.senderId === receiverId && m.receiverId === senderId)
  );

  res.json(messages);
});

// Send new message
app.post('/api/messages', (req, res) => {
  const { senderId, receiverId, message } = req.body;
  const db = readDB();

  const newMessage = {
    id: 'm_' + Date.now(),
    senderId,
    receiverId,
    message,
    timestamp: new Date().toISOString(),
    read: false
  };

  db.messages.push(newMessage);

  // Mark all previous messages from receiver as read
  db.messages.forEach((m: any) => {
    if (m.senderId === receiverId && m.receiverId === senderId) {
      m.read = true;
    }
  });

  // Create chat notification
  db.notifications.push({
    id: 'n_' + Date.now(),
    userId: receiverId,
    text: `New chat message from ${db.users.find((u: any) => u.id === senderId)?.name || 'User'}: "${message.substring(0, 30)}..."`,
    type: 'chat',
    read: false,
    createdAt: new Date().toISOString()
  });

  writeDB(db);
  res.status(201).json(newMessage);
});

// ================= REVIEWS & RATINGS =================

app.get('/api/reviews', (req, res) => {
  const { userId } = req.query;
  const db = readDB();

  let results = [...db.reviews];
  if (userId) {
    results = results.filter(r => r.revieweeId === userId);
  }
  res.json(results);
});

app.post('/api/reviews', (req, res) => {
  const { bookingId, rating, comment, reviewerId, revieweeId } = req.body;
  const db = readDB();

  const reviewer = db.users.find((u: any) => u.id === reviewerId);
  const reviewee = db.users.find((u: any) => u.id === revieweeId);

  if (!reviewer || !reviewee) {
    return res.status(404).json({ error: 'Reviewer or Reviewee not found' });
  }

  const newReview = {
    id: 'rev_' + Date.now(),
    bookingId,
    rating: Number(rating),
    comment,
    reviewerId,
    reviewerName: reviewer.name,
    revieweeId,
    revieweeName: reviewee.name,
    createdAt: new Date().toISOString()
  };

  db.reviews.push(newReview);

  // Send notification to reviewee
  db.notifications.push({
    id: 'n_' + Date.now(),
    userId: revieweeId,
    text: `${reviewer.name} left you a ${rating}-star review: "${comment.substring(0, 30)}..."`,
    type: 'review',
    read: false,
    createdAt: new Date().toISOString()
  });

  writeDB(db);
  res.status(201).json(newReview);
});

// ================= NOTIFICATIONS =================

app.get('/api/notifications', (req, res) => {
  const { userId } = req.query;
  const db = readDB();
  const list = db.notifications.filter((n: any) => n.userId === userId);
  res.json(list.sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt)));
});

app.patch('/api/notifications/:id/read', (req, res) => {
  const { id } = req.params;
  const db = readDB();

  const item = db.notifications.find((n: any) => n.id === id);
  if (item) {
    item.read = true;
  }
  writeDB(db);
  res.json({ success: true });
});

// ================= ADMIN CONSOLE ENDPOINTS =================

// Admin dashboard summary stats
app.get('/api/admin/report', (req, res) => {
  const db = readDB();
  const reports = {
    totalUsers: db.users.filter((u: any) => u.role !== 'admin').length,
    totalSkills: db.skills.length,
    totalRequests: db.exchange_requests.length,
    totalSessions: db.sessions.length,
    totalReviews: db.reviews.length,
    fakeAccounts: db.users.filter((u: any) => u.isFake).map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      bio: u.bio
    }))
  };
  res.json(reports);
});

// Admin deletes user
app.delete('/api/admin/users/:id', (req, res) => {
  const { id } = req.params;
  const db = readDB();

  db.users = db.users.filter((u: any) => u.id !== id);
  db.skills = db.skills.filter((s: any) => s.userId !== id);
  db.exchange_requests = db.exchange_requests.filter((r: any) => r.senderId !== id && r.receiverId !== id);

  writeDB(db);
  res.json({ success: true, message: 'User and all associated skills deleted.' });
});

// Admin deletes skill
app.delete('/api/admin/skills/:id', (req, res) => {
  const { id } = req.params;
  const db = readDB();
  db.skills = db.skills.filter((s: any) => s.id !== id);
  writeDB(db);
  res.json({ success: true, message: 'Skill deleted by Admin' });
});

// Admin removes all fake flagged accounts
app.post('/api/admin/remove-fake', (req, res) => {
  const db = readDB();
  const beforeCount = db.users.length;
  db.users = db.users.filter((u: any) => !u.isFake);
  const afterCount = db.users.length;

  writeDB(db);
  res.json({
    success: true,
    removedCount: beforeCount - afterCount,
    message: `Successfully purged ${beforeCount - afterCount} spam accounts from the directory!`
  });
});

// ================= GEMINI AI POWERED RECOMMENDATION =================

app.post('/api/gemini/recommendations', async (req, res) => {
  const { userId } = req.body;
  const db = readDB();

  const user = db.users.find((u: any) => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const aiClient = getGeminiClient();

  // Retrieve active exchange catalog
  const databaseSkills = db.skills.filter((s: any) => s.userId !== userId);
  const skillListString = databaseSkills
    .map((s: any) => `- "${s.name}" (Category: ${s.category}, Level: ${s.level}, taught by ${s.userName})`)
    .join('\n');

  const prompt = `
    You are the AI Matchmaker for the "Skill Exchange System".
    We want to recommend perfect peer-to-peer tutoring matches.

    User Profile:
    - Name: ${user.name}
    - Bio: ${user.bio}
    - Skills Offered: ${user.skillsOffered.join(', ')}
    - Skills Wanted: ${user.skillsWanted.join(', ')}
    - Experience level: ${user.experienceLevel}

    Available catalog of skills from other users:
    ${skillListString || 'No other skills available right now.'}

    Recommend 2 skill exchanges that make sense based on what they want to learn vs what others teach.
    Return a valid JSON object matching the schema below.
    Do NOT include any extra formatting, markdown tickmarks or explanations outside of the JSON.

    Required JSON Schema:
    {
      "explanation": "Brief paragraph explaining why matches are highly relevant to your background.",
      "recommendations": [
        {
          "skillName": "Name of the recommended skill in database",
          "teacherName": "Name of the teacher",
          "offeredSkillMatch": "Which of your offered skills they would likely want",
          "reasoning": "Quick engaging sentence explaining why this match is perfect for both."
        }
      ]
    }
  `;

  try {
    if (aiClient) {
      const response = await aiClient.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json'
        }
      });

      const text = response.text || '';
      const cleanJson = text.trim();
      const parsed = JSON.parse(cleanJson);
      return res.json(parsed);
    } else {
      // Fallback fallback generator when Gemini API Key is not set or invalid
      throw new Error('Gemini client not initialized');
    }
  } catch (err) {
    console.warn('Gemini recommendation fallback activated:', err);

    // Dynamic heuristic recommendations based on overlapping skills
    const recommendations: any[] = [];
    const lowerWanted = user.skillsWanted.map((s: string) => s.toLowerCase());

    databaseSkills.forEach((s: any) => {
      // check if this skill matches any of user's wanted skills
      const isWanted = lowerWanted.some((w: string) => s.name.toLowerCase().includes(w) || w.includes(s.name.toLowerCase()));
      if (isWanted && recommendations.length < 2) {
        recommendations.push({
          skillName: s.name,
          teacherName: s.userName,
          offeredSkillMatch: user.skillsOffered[0] || 'Web Technologies',
          reasoning: `Perfect mutual exchange! You want to learn ${s.name} from ${s.userName}, and they are looking for tech/general knowledge.`
        });
      }
    });

    // Default seed recommendations if no overlap is detected
    if (recommendations.length === 0 && databaseSkills.length > 0) {
      const firstSkill = databaseSkills[0];
      recommendations.push({
        skillName: firstSkill.name,
        teacherName: firstSkill.userName,
        offeredSkillMatch: user.skillsOffered[0] || 'Any Skill',
        reasoning: `${firstSkill.userName} teaches "${firstSkill.name}", which expands your horizons beyond your current expert list.`
      });
    }

    res.json({
      explanation: "Our heuristic matching engine analyzed the skill catalog and found direct overlaps. Complete setting up your Gemini API Key in 'Secrets' for fully conversational neural recommendations!",
      recommendations: recommendations
    });
  }
});

// ================= VITE OR STATIC SERVING =================

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
