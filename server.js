require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Google Gemini — primary AI provider for the nutrition chat assistant
let genAI = null;
try {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const key = process.env.GEMINI_API_KEY;
  if (key && key !== 'your_key_here' && key.length > 12) {
    genAI = new GoogleGenerativeAI(key);
  }
} catch (e) { /* SDK not installed or no key — fall back to built-in assistant */ }

// ─── Data storage (server-side JSON files) ──────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'nutribase-georgia-secret-key-2035';
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const FRIDGES_FILE = path.join(DATA_DIR, 'fridges.json');
const MEALPLANS_FILE = path.join(DATA_DIR, 'mealplans.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
for (const f of [USERS_FILE, FRIDGES_FILE, MEALPLANS_FILE, LOGS_FILE]) {
  if (!fs.existsSync(f)) fs.writeFileSync(f, '[]', 'utf8');
}
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8') || '[]'); } catch { return []; } };
const writeJSON = (f, data) => fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
const publicUser = (u) => { const { password, ...rest } = u; return rest; };

// JWT auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.userId = jwt.verify(token, JWT_SECRET).id;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Activity multipliers
const ACTIVITY = { sedentary: 1.2, light: 1.375, moderate: 1.55, very: 1.725, extreme: 1.9 };
const CALS_PER_KG = 7700;
const MAX_DEFICIT = -1000;   // 2 kg/week max loss
const MAX_SURPLUS = 500;     // 0.5 kg/week max gain

// Advanced Mifflin-St Jeor + target-weight/timeline calorie engine
function calcCalories(p) {
  if (!p || !p.weight || !p.height || !p.age) return null;
  const gender = p.gender === 'female' ? 'female' : 'male';
  const bmr = 10 * p.weight + 6.25 * p.height - 5 * p.age + (gender === 'female' ? -161 : 5);
  const mult = ACTIVITY[p.activityLevel] || 1.55;
  const tdee = bmr * mult;

  const current = Number(p.weight);
  const targetW = (p.targetWeight != null && p.targetWeight !== '') ? Number(p.targetWeight) : current;
  const weeks = Number(p.timeline) || 12;
  const diff = +(targetW - current).toFixed(2);                 // +gain / -lose (kg)
  const direction = diff < -0.05 ? 'lose' : diff > 0.05 ? 'gain' : 'maintain';

  const totalCals = diff * CALS_PER_KG;
  const requestedDaily = weeks > 0 ? totalCals / (weeks * 7) : 0; // +surplus / -deficit

  let dailyAdjust = requestedDaily;
  let warning = null, suggestedWeeks = null;
  if (requestedDaily < MAX_DEFICIT) {
    dailyAdjust = MAX_DEFICIT;
    suggestedWeeks = Math.ceil(Math.abs(totalCals) / (Math.abs(MAX_DEFICIT) * 7));
    warning = `This pace is too aggressive. Losing more than 1kg/week can cause muscle loss and nutrient deficiencies. We recommend ${suggestedWeeks} weeks instead for healthy results.`;
  } else if (requestedDaily > MAX_SURPLUS) {
    dailyAdjust = MAX_SURPLUS;
    suggestedWeeks = Math.ceil(totalCals / (MAX_SURPLUS * 7));
    warning = `This pace is too aggressive. Gaining more than 0.5kg/week tends to add fat rather than muscle. We recommend ${suggestedWeeks} weeks instead for lean results.`;
  }

  let target = Math.round(tdee + dailyAdjust);
  const minCal = gender === 'female' ? 1200 : 1500;
  let minClamped = false;
  if (target < minCal) { target = minCal; dailyAdjust = Math.round(target - tdee); minClamped = true; }

  const weeklyChange = +((dailyAdjust * 7) / CALS_PER_KG).toFixed(3);  // signed kg/week
  let effWeeks = weeks;
  if (direction === 'maintain') effWeeks = 0;
  else if (Math.abs(weeklyChange) > 0.0001) effWeeks = Math.abs(diff / weeklyChange);
  effWeeks = Math.round(effWeeks * 10) / 10;

  const completionDate = direction === 'maintain'
    ? null
    : new Date(Date.now() + effWeeks * 7 * 86400000).toISOString().slice(0, 10);

  const prediction = [];
  const totalWeeks = Math.min(Math.max(Math.ceil(effWeeks), 1), 52);
  for (let w = 0; w <= totalWeeks; w++) {
    let val = current + weeklyChange * w;
    if (direction === 'lose') val = Math.max(val, targetW);
    if (direction === 'gain') val = Math.min(val, targetW);
    prediction.push({ week: w, weight: +val.toFixed(1) });
  }

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    target,
    dailyAdjust: Math.round(dailyAdjust),
    weeklyChange,
    direction,
    goalKg: +Math.abs(diff).toFixed(1),
    currentWeight: current,
    targetWeight: targetW,
    weeks,
    effWeeks,
    completionDate,
    minClamped,
    warning,
    suggestedWeeks,
    activityMultiplier: mult,
    protein: Math.round((target * 0.30) / 4),
    carbs: Math.round((target * 0.40) / 4),
    fats: Math.round((target * 0.30) / 9),
    prediction,
  };
}

const foods = [
  {
    id: 'apple',
    name: 'Apple',
    emoji: '🍎',
    color: '#e74c3c',
    calories: 52,
    nutrition: { protein: 0.3, carbs: 14, fat: 0.2, fiber: 2.4, vitaminC: 7.2, vitaminK: 2.4, vitaminB6: 0.02 },
    benefits: [
      'Rich in antioxidants and quercetin',
      'High dietary fiber supports digestion',
      'May reduce risk of heart disease',
      'Supports gut microbiome health',
      'Natural energy boost from fructose'
    ],
    drawbacks: [
      'High natural sugar content',
      'May cause blood sugar spikes in diabetics',
      'Pesticide residue risk if non-organic',
      'Acidic — can affect tooth enamel'
    ],
    description: 'A crisp, sweet fruit packed with fiber and vitamin C.',
    serving: '100g'
  },
  {
    id: 'banana',
    name: 'Banana',
    emoji: '🍌',
    color: '#f1c40f',
    calories: 89,
    nutrition: { protein: 1.1, carbs: 23, fat: 0.3, fiber: 2.6, vitaminB6: 0.34, vitaminC: 8.1, potassium: 376 },
    benefits: [
      'Excellent source of potassium for heart health',
      'Provides quick, sustained energy',
      'Rich in vitamin B6 for brain health',
      'Contains dopamine antioxidants',
      'Supports muscle recovery post-exercise'
    ],
    drawbacks: [
      'High glycemic index when ripe',
      'High in sugar compared to other fruits',
      'Not ideal for low-carb diets',
      'Unripe bananas can cause bloating'
    ],
    description: 'A tropical fruit rich in potassium and natural energy.',
    serving: '100g'
  },
  {
    id: 'chicken',
    name: 'Chicken Breast',
    emoji: '🍗',
    color: '#f39c12',
    calories: 165,
    nutrition: { protein: 31, carbs: 0, fat: 3.6, fiber: 0, vitaminB6: 0.85, vitaminB12: 0.48, niacin: 9.6 },
    benefits: [
      'Highest protein-to-calorie ratio of common meats',
      'Complete amino acid profile for muscle building',
      'Low in saturated fat',
      'Rich in niacin for metabolic health',
      'Supports immune function via zinc and selenium'
    ],
    drawbacks: [
      'Can become dry/tough if overcooked',
      'Factory-farmed versions may contain antibiotics',
      'Low in omega-3 fatty acids',
      'Minimal micronutrient diversity'
    ],
    description: 'Lean protein powerhouse ideal for muscle growth and repair.',
    serving: '100g'
  },
  {
    id: 'fish',
    name: 'Fish (Salmon)',
    emoji: '🐟',
    color: '#e67e22',
    calories: 208,
    nutrition: { protein: 20, carbs: 0, fat: 13, fiber: 0, omega3: 2.3, vitaminD: 600, vitaminB12: 1.22, selenium: 19.8 },
    benefits: [
      'Highest dietary source of omega-3 fatty acids',
      'Reduces inflammation throughout the body',
      'Exceptional source of vitamin D',
      'Supports brain health and cognitive function',
      'Linked to reduced cardiovascular disease risk'
    ],
    drawbacks: [
      'Higher mercury levels in larger species',
      'Farmed salmon may contain PCBs',
      'Expensive compared to other proteins',
      'Allergenic for fish-sensitive individuals'
    ],
    description: 'Omega-3 rich fatty fish with exceptional cardiovascular benefits.',
    serving: '100g'
  },
  {
    id: 'almond',
    name: 'Almond',
    emoji: '🥜',
    color: '#8B6914',
    calories: 579,
    nutrition: { protein: 21, carbs: 22, fat: 49, fiber: 12.5, vitaminE: 20.6, magnesium: 281, calcium: 260 },
    benefits: [
      'Outstanding source of vitamin E antioxidant',
      'Rich in monounsaturated heart-healthy fats',
      'High magnesium supports blood sugar control',
      'Reduces LDL cholesterol levels',
      'Promotes satiety and weight management'
    ],
    drawbacks: [
      'Very calorie-dense — easy to overeat',
      'Contains oxalates that may affect kidney stones',
      'Common allergen (tree nut)',
      'Phytic acid can reduce mineral absorption'
    ],
    description: 'Nutrient-dense tree nut rich in healthy fats and vitamin E.',
    serving: '100g'
  },
  {
    id: 'egg',
    name: 'Eggs',
    emoji: '🥚',
    color: '#F5E6C8',
    calories: 155,
    nutrition: { protein: 13, carbs: 1.1, fat: 11, fiber: 0, vitaminB12: 1.1, selenium: 24.2, choline: 330 },
    benefits: [
      'Complete protein with all 9 essential amino acids',
      'Rich in choline for brain health and memory',
      'Lutein and zeaxanthin support eye health',
      'Most affordable high-quality protein source',
      'Supports muscle building and repair'
    ],
    drawbacks: [
      'High dietary cholesterol (though largely benign for most people)',
      'Common allergen — affects ~1-2% of children',
      'Must be cooked properly to avoid Salmonella risk',
      'Factory-farmed eggs lower in omega-3 than pasture-raised'
    ],
    description: "Nature's most complete food — affordable, versatile, and nutritionally dense.",
    serving: '100g'
  },
  {
    id: 'sweetpotato',
    name: 'Sweet Potato',
    emoji: '🍠',
    color: '#E8611A',
    calories: 86,
    nutrition: { protein: 1.6, carbs: 20, fat: 0.1, fiber: 3, vitaminA: 2556, vitaminC: 3.6, vitaminB6: 0.24 },
    benefits: [
      'Extraordinary beta-carotene source — over 960% daily vitamin A',
      'Powerful anti-inflammatory carotenoids',
      'Complex carbs provide sustained, stable energy',
      'High fiber supports gut health and satiety',
      'Naturally sweet with no added sugar'
    ],
    drawbacks: [
      'High glycemic index — can spike blood sugar when baked',
      'High carbohydrate content (not keto-friendly)',
      'Can cause bloating and gas if eaten in large amounts',
      'Oxalates may be a concern for kidney stone prone individuals'
    ],
    description: 'An orange root vegetable loaded with beta-carotene, fiber, and complex carbs.',
    serving: '100g'
  },
  {
    id: 'broccoli', name: 'Broccoli', emoji: '🥦', color: '#22863a', calories: 34,
    nutrition: { protein: 2.8, carbs: 7, fiber: 2.6, fat: 0.4, vitaminC: 80.1, vitaminK: 92.4, folate: 56 },
    benefits: [
      'Cancer-fighting sulforaphane compound',
      'Exceptional vitamin K supports bone density',
      'High vitamin C boosts immune system',
      'Powerful anti-inflammatory antioxidants',
      'High fiber supports healthy digestion'
    ],
    drawbacks: [
      'Can cause bloating and gas from raffinose fiber',
      'Goitrogens may interfere with thyroid if eaten raw in large amounts',
      'Bitter taste when overcooked'
    ],
    description: 'A cruciferous vegetable powerhouse loaded with cancer-fighting sulforaphane.',
    serving: '100g'
  },
  {
    id: 'avocado', name: 'Avocado', emoji: '🥑', color: '#355e3b', calories: 160,
    nutrition: { protein: 2, carbs: 9, fiber: 7, fat: 15, vitaminK: 31.2, folate: 80, vitaminB6: 0.22 },
    benefits: [
      'Rich in heart-healthy monounsaturated fats',
      'High folate supports brain and cell health',
      'Boosts absorption of fat-soluble vitamins from other foods',
      'Promotes healthy skin and reduces inflammation',
      'Reduces LDL (bad) cholesterol levels'
    ],
    drawbacks: [
      'Very calorie-dense — easy to overeat',
      'Expensive and seasonal',
      'High fat content (though mostly healthy)'
    ],
    description: 'A creamy, nutrient-rich fruit packed with heart-healthy fats and folate.',
    serving: '100g'
  },
  {
    id: 'blueberry', name: 'Blueberries', emoji: '🫐', color: '#4b3b8c', calories: 57,
    nutrition: { protein: 0.7, carbs: 14, fiber: 2.4, fat: 0.3, vitaminC: 14.4, vitaminK: 28.8, manganese: 0.39 },
    benefits: [
      'Highest antioxidant content of all common fruits',
      'Anthocyanins improve brain function and memory',
      'Reduces oxidative stress and anti-aging effects',
      'Supports heart health and lowers blood pressure',
      'Helps regulate blood sugar levels'
    ],
    drawbacks: [
      'Can stain teeth with regular consumption',
      'High in natural sugars',
      'Expensive when out of season'
    ],
    description: 'A small but mighty berry with the highest antioxidant capacity of any common fruit.',
    serving: '100g'
  },
  {
    id: 'spinach', name: 'Spinach', emoji: '🥬', color: '#2d6a2f', calories: 23,
    nutrition: { protein: 2.9, carbs: 3.6, fiber: 2.2, fat: 0.4, vitaminK: 552, vitaminA: 1692, folate: 196, vitaminC: 42.3 },
    benefits: [
      'Extraordinary vitamin K content for bone health',
      'Lutein and zeaxanthin protect eye health',
      'Iron supports healthy blood and oxygen transport',
      'Extremely low calorie — virtually free nutrition',
      'Powerful anti-inflammatory flavonoids'
    ],
    drawbacks: [
      'Oxalates block calcium and iron absorption',
      'High vitamin K interacts with blood thinners',
      'Can contribute to kidney stones in excess'
    ],
    description: 'One of the most nutrient-dense foods on earth — extremely high vitamin K with near-zero calories.',
    serving: '100g'
  },
  {
    id: 'greekyogurt', name: 'Greek Yogurt', emoji: '🍦', color: '#f0ede6', calories: 59,
    nutrition: { protein: 10, carbs: 3.6, fiber: 0, fat: 0.4, vitaminB12: 0.31, calcium: 110, phosphorus: 90 },
    benefits: [
      'Extremely high protein — twice that of regular yogurt',
      'Probiotics support gut health and immune function',
      'High calcium and phosphorus for strong bones',
      'Promotes satiety and supports weight management',
      'Fast muscle recovery after exercise'
    ],
    drawbacks: [
      'Lactose intolerance can cause digestive discomfort',
      'Flavored versions often loaded with added sugar',
      'More expensive than regular yogurt'
    ],
    description: 'A strained yogurt with double the protein of regular yogurt and powerful probiotic benefits.',
    serving: '100g'
  },
  {
    id: 'carrot', name: 'Carrot', emoji: '🥕', color: '#f97316', calories: 41,
    nutrition: { protein: 0.9, carbs: 10, fiber: 2.8, fat: 0.2, vitaminA: 3006, vitaminK: 15.6, vitaminB6: 0.14 },
    benefits: [
      'Extraordinary beta-carotene source for vision and immune health',
      'Antioxidants reduce risk of certain cancers',
      'Supports healthy skin from the inside out',
      'Excellent low-calorie snack with satisfying crunch',
      'Biotin supports hair and nail health'
    ],
    drawbacks: [
      'High glycemic index when cooked',
      'Excessive consumption can turn skin orange (carotenemia)',
      'Low in complete protein'
    ],
    description: 'An orange root packed with beta-carotene — one of the best plant sources of vitamin A.',
    serving: '100g'
  },
  {
    id: 'oats', name: 'Oats', emoji: '🥣', color: '#d4a853', calories: 389,
    nutrition: { protein: 17, carbs: 66, fiber: 10.6, fat: 7, manganese: 5.66, phosphorus: 520, magnesium: 185 },
    benefits: [
      'Beta-glucan fiber clinically proven to lower LDL cholesterol',
      'Sustained slow-release energy from complex carbohydrates',
      'Prebiotic fiber supports beneficial gut bacteria',
      'Helps stabilize blood sugar after meals',
      'One of the best plant-based sources of manganese'
    ],
    drawbacks: [
      'High in carbohydrates — not ideal for keto/low-carb',
      'Risk of gluten cross-contamination for celiac disease',
      'Phytic acid can reduce mineral absorption if not soaked'
    ],
    description: 'The gold standard breakfast grain — beta-glucan fiber actively lowers cholesterol.',
    serving: '100g'
  },
  {
    id: 'lemon', name: 'Lemon', emoji: '🍋', color: '#fde047', calories: 29,
    nutrition: { protein: 1.1, carbs: 9, fiber: 2.8, fat: 0.3, vitaminC: 79.2, vitaminB6: 0.1, folate: 12 },
    benefits: [
      'High vitamin C strengthens immune system',
      'Aids digestion and promotes bile production',
      'Alkalizing effect despite acidic taste',
      'Antibacterial properties from limonene',
      'Brightens skin and reduces hyperpigmentation'
    ],
    drawbacks: [
      'Highly acidic — erodes tooth enamel with frequent contact',
      'Can trigger acid reflux in sensitive individuals',
      'Needs to be combined — too sour to eat alone'
    ],
    description: 'A tangy citrus powerhouse with high vitamin C and powerful digestive benefits.',
    serving: '100g'
  },
  {
    id: 'walnut', name: 'Walnuts', emoji: '🫘', color: '#8b5e3c', calories: 654,
    nutrition: { protein: 15, carbs: 14, fiber: 6.7, fat: 65, omega3: 9, manganese: 3.75, copper: 0.7 },
    benefits: [
      'Highest omega-3 content of all tree nuts',
      'Compounds that directly support brain health',
      'Reduces inflammation throughout the body',
      'Lowers LDL cholesterol and blood pressure',
      'Contains melatonin to support sleep quality'
    ],
    drawbacks: [
      'Very calorie-dense — easy to overconsume',
      'Expensive compared to other nuts',
      'Oxalates can contribute to kidney stones'
    ],
    description: 'Brain-shaped and brain-boosting — the richest nut source of plant-based omega-3.',
    serving: '100g'
  },
  {
    id: 'tomato', name: 'Tomato', emoji: '🍅', color: '#dc2626', calories: 18,
    nutrition: { protein: 0.9, carbs: 3.9, fiber: 1.2, fat: 0.2, vitaminC: 20.7, vitaminK: 9.6, lycopene: 2.6, vitaminA: 72 },
    benefits: [
      'Lycopene is a powerful antioxidant linked to cancer prevention',
      'Supports heart health and reduces cardiovascular risk',
      'UV skin protection from carotenoids',
      'Anti-inflammatory and immune-boosting properties',
      'Extremely low in calories for volume of nutrition'
    ],
    drawbacks: [
      'Acidic — can trigger acid reflux or heartburn',
      'Nightshade sensitivity in some individuals',
      'Lycopene bioavailability is highest only when cooked'
    ],
    description: 'A lycopene-rich red fruit with powerful cancer-preventive antioxidant properties.',
    serving: '100g'
  },
  {
    id: 'garlic', name: 'Garlic', emoji: '🧄', color: '#f5f0e0', calories: 149,
    nutrition: { protein: 6.4, carbs: 33, fiber: 2.1, fat: 0.5, vitaminB6: 1.62, vitaminC: 34.2, manganese: 1.68 },
    benefits: [
      'Allicin compound has potent antibacterial and antiviral effects',
      'Clinically proven to lower blood pressure',
      'Boosts immune system function',
      'Anti-cancer properties from organosulfur compounds',
      'Functions as a natural antibiotic'
    ],
    drawbacks: [
      'Strong breath and body odor after consumption',
      'Can cause digestive upset and bloating',
      'Blood-thinning interaction with medications',
      'Very pungent flavor requires careful culinary use'
    ],
    description: 'The original medicine — allicin makes garlic one of the most powerful natural antibiotics.',
    serving: '100g'
  },
  {
    id: 'darkchocolate', name: 'Dark Chocolate', emoji: '🍫', color: '#3d1a0a', calories: 598,
    nutrition: { protein: 7.8, carbs: 46, fiber: 10.9, fat: 43, iron: 12.06, magnesium: 244, copper: 0.8, manganese: 2.25 },
    benefits: [
      'Richest food source of antioxidant flavonoids',
      'Theobromine and serotonin precursors improve mood',
      'Reduces LDL oxidation and supports heart health',
      'Improves brain blood flow and cognitive function',
      'Magnesium supports muscle and nerve function'
    ],
    drawbacks: [
      'High in calories — easy to overindulge',
      'Contains caffeine (may affect sleep)',
      'High fat content despite being healthy fat',
      'Sugar content varies significantly by brand'
    ],
    description: 'Luxury nutrition — high-cacao dark chocolate is one of the best antioxidant foods on earth.',
    serving: '100g'
  },
  {
    id: 'kiwi', name: 'Kiwi', emoji: '🥝', color: '#4d7c0f', calories: 61,
    nutrition: { protein: 1.1, carbs: 15, fiber: 3, fat: 0.5, vitaminC: 138.6, vitaminK: 48, vitaminE: 1.5 },
    benefits: [
      'Higher vitamin C per gram than oranges',
      'Improves sleep quality via serotonin pathway',
      'Actinidin enzyme aids protein digestion',
      'Controls blood pressure via potassium balance',
      'Antioxidants protect skin from UV damage'
    ],
    drawbacks: [
      'Oral allergy syndrome in some individuals',
      'Oxalates can aggravate kidney stone risk',
      'Can be expensive depending on region'
    ],
    description: 'A furry brown fruit hiding extraordinary vitamin C and sleep-improving compounds.',
    serving: '100g'
  },
  {
    id: 'quinoa', name: 'Quinoa', emoji: '🌾', color: '#d4c5a0', calories: 368,
    nutrition: { protein: 14, carbs: 64, fiber: 7, fat: 6, manganese: 2.14, phosphorus: 590, magnesium: 206 },
    benefits: [
      'One of the few plant foods containing all 9 essential amino acids',
      'Naturally gluten-free — safe for celiac disease',
      'High fiber supports gut health and satiety',
      'Low glycemic index despite high carb content',
      'Exceptionally rich in magnesium and manganese'
    ],
    drawbacks: [
      'High in carbohydrates for a "protein food"',
      'Saponin coating must be rinsed before cooking',
      'More expensive than rice or pasta',
      'High oxalate content'
    ],
    description: 'The complete plant protein — one of only a few plant foods with all essential amino acids.',
    serving: '100g'
  },
  {
    id: 'ginger', name: 'Ginger', emoji: '🫚', color: '#c8a96e', calories: 80,
    nutrition: { protein: 1.8, carbs: 18, fiber: 2, fat: 0.8, vitaminB6: 0.19, magnesium: 42, potassium: 329 },
    benefits: [
      'Gingerol is a uniquely potent anti-inflammatory compound',
      'Clinically proven to relieve nausea and morning sickness',
      'Reduces exercise-induced muscle pain and soreness',
      'Lowers blood sugar and improves insulin sensitivity',
      'Powerful digestive aid for bloating and discomfort'
    ],
    drawbacks: [
      'Blood-thinning properties interact with medications',
      'Can cause heartburn in sensitive individuals',
      'Very strong spicy flavor requires careful dosing',
      'Not safe in large medicinal doses during pregnancy'
    ],
    description: 'A knobby root with extraordinary anti-inflammatory power from its active compound gingerol.',
    serving: '100g'
  },
  {
    id: 'whiterice', name: 'White Rice', emoji: '🍚', color: '#f5f5f0', calories: 130,
    nutrition: { protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4, manganese: 0.32, thiamine: 0.12, niacin: 1.28 },
    benefits: [
      'Fast, easily accessible energy source',
      'Very easy to digest — gentle on the stomach',
      'Naturally gluten-free',
      'Versatile staple that pairs with almost anything',
      'Naturally low in fat'
    ],
    drawbacks: [
      'Low in fiber compared to whole grains',
      'High glycemic index — spikes blood sugar quickly',
      'Nutrient-poor relative to brown rice',
      'Minimal protein and micronutrient density'
    ],
    description: 'A fluffy, easily digestible staple grain — quick energy that pairs with everything.',
    serving: '100g'
  },
  {
    id: 'brownrice', name: 'Brown Rice', emoji: '🍚', color: '#b08d57', calories: 111,
    nutrition: { protein: 2.6, carbs: 23, fat: 0.9, fiber: 1.8, manganese: 1.04, magnesium: 46, phosphorus: 80 },
    benefits: [
      'Much higher fiber than white rice',
      'Sustained, slow-release energy',
      'Supports heart health via whole-grain compounds',
      'Better blood sugar control than white rice',
      'Exceptionally rich in manganese and magnesium'
    ],
    drawbacks: [
      'Longer cooking time than white rice',
      'Harder to digest for some people',
      'Can contain trace arsenic from the bran layer',
      'Shorter shelf life due to natural oils'
    ],
    description: 'The whole-grain rice — bran and germ intact for far more fiber and minerals.',
    serving: '100g'
  },
  {
    id: 'wholewheatbread', name: 'Whole Wheat Bread', emoji: '🍞', color: '#b5793a', calories: 247,
    nutrition: { protein: 13, carbs: 41, fat: 3.4, fiber: 7, manganese: 3.75, selenium: 34.1, thiamine: 0.46 },
    benefits: [
      'Higher fiber than refined white bread',
      'Sustained energy from complex carbohydrates',
      'Whole grains support heart health',
      'Prebiotic fiber supports gut health',
      'Good source of B vitamins'
    ],
    drawbacks: [
      'Contains gluten — unsuitable for celiac disease',
      'Phytic acid can reduce mineral absorption',
      'Some commercial brands add sugar',
      'Calorie-dense if eaten in large amounts'
    ],
    description: 'Whole-grain bread with intact bran — far more fiber and B vitamins than white.',
    serving: '100g'
  },
  {
    id: 'pasta', name: 'Pasta', emoji: '🍝', color: '#e8cd6d', calories: 158,
    nutrition: { protein: 5.8, carbs: 31, fat: 0.9, fiber: 1.8, selenium: 14.3, manganese: 0.37, folate: 28 },
    benefits: [
      'Reliable energy source for active days',
      'High in selenium for antioxidant defense',
      'Endlessly versatile culinary base',
      'Filling and satisfying',
      'Lower glycemic index than white bread'
    ],
    drawbacks: [
      'High in carbohydrates',
      'Usually made from refined flour',
      'Contains gluten',
      'Very easy to overeat large portions',
      'Low nutrient density unless whole-grain'
    ],
    description: 'A beloved energy staple — high in selenium and endlessly versatile.',
    serving: '100g'
  },
  {
    id: 'corn', name: 'Corn', emoji: '🌽', color: '#f5c542', calories: 86,
    nutrition: { protein: 3.2, carbs: 19, fat: 1.2, fiber: 2.4, thiamine: 0.18, vitaminB6: 0.14, folate: 28 },
    benefits: [
      'Rich in eye-protecting antioxidants lutein and zeaxanthin',
      'Good source of dietary fiber',
      'Satisfying natural energy source',
      'Naturally gluten-free',
      'Versatile across countless dishes'
    ],
    drawbacks: [
      'Higher in natural sugar than most vegetables',
      'Often genetically modified',
      'High glycemic index',
      'Lower-quality protein profile',
      'Can cause bloating in some people'
    ],
    description: 'A sweet, antioxidant-rich grain vegetable loaded with eye-protecting carotenoids.',
    serving: '100g'
  },
  {
    id: 'lentils', name: 'Lentils', emoji: '🫘', color: '#6b8e23', calories: 116,
    nutrition: { protein: 9, carbs: 20, fat: 0.4, fiber: 7.9, folate: 180, manganese: 0.58, iron: 3.42 },
    benefits: [
      'Extraordinarily high in dietary fiber',
      'Excellent plant-based protein source',
      'Helps control blood sugar levels',
      'Supports heart health',
      'Strong source of plant iron and folate'
    ],
    drawbacks: [
      'Can cause gas and bloating',
      'Contains antinutrients that reduce mineral absorption',
      'Requires longer cooking time',
      'Lower in some essential amino acids'
    ],
    description: 'A fiber-and-protein powerhouse legume — one of the best plant iron sources.',
    serving: '100g'
  },
  {
    id: 'blackbeans', name: 'Black Beans', emoji: '🫘', color: '#2a2a2e', calories: 132,
    nutrition: { protein: 8.9, carbs: 24, fat: 0.5, fiber: 8.7, folate: 148, manganese: 0.51, thiamine: 0.19 },
    benefits: [
      'Powerful fiber-plus-protein combination',
      'Supports heart health',
      'Helps stabilize blood sugar',
      'Antioxidant anthocyanins from the dark skin',
      'An inexpensive nutritional superfood'
    ],
    drawbacks: [
      'Can cause gas and bloating',
      'Antinutrients — soak before cooking',
      'High in carbohydrates',
      'Incomplete protein on its own'
    ],
    description: 'A glossy antioxidant-rich legume delivering an exceptional fiber-and-protein combo.',
    serving: '100g'
  },
  {
    id: 'chickpeas', name: 'Chickpeas', emoji: '🫛', color: '#e3c79a', calories: 164,
    nutrition: { protein: 8.9, carbs: 27, fat: 2.6, fiber: 7.6, folate: 172, manganese: 1.2, copper: 0.16 },
    benefits: [
      'High in both fiber and plant protein',
      'Helps control blood sugar',
      'Promotes satiety and weight management',
      'Supports heart health',
      'Incredibly versatile — the base of hummus'
    ],
    drawbacks: [
      'High in carbohydrates',
      'Can cause gas and bloating',
      'Contains antinutrients',
      'Not a complete protein on its own'
    ],
    description: 'A versatile, mineral-dense legume — the protein-packed foundation of hummus.',
    serving: '100g'
  },
  {
    id: 'corntortilla', name: 'Corn Tortilla', emoji: '🫓', color: '#ecd9a0', calories: 218,
    nutrition: { protein: 5.7, carbs: 46, fat: 2.5, fiber: 6.7, calcium: 90, iron: 1.98, magnesium: 34 },
    benefits: [
      'Naturally gluten-free',
      'Low in calories',
      'Easy to digest',
      'Versatile traditional staple',
      'Nixtamalized corn provides bioavailable calcium'
    ],
    drawbacks: [
      'Low overall nutrient density',
      'High glycemic index',
      'Low in protein',
      'Often made from refined corn masa'
    ],
    description: 'A traditional gluten-free flatbread — light, foldable, and endlessly versatile.',
    serving: '100g'
  },
  {
    id: 'buckwheat', name: 'Buckwheat', emoji: '🌾', color: '#a8825a', calories: 92,
    nutrition: { protein: 3.4, carbs: 20, fat: 0.6, fiber: 2.7, manganese: 0.46, copper: 0.06, magnesium: 29 },
    benefits: [
      'A complete protein with all essential amino acids',
      'Naturally gluten-free despite the name',
      'Supports heart health',
      'Helps regulate blood sugar',
      'Rich in the antioxidant rutin'
    ],
    drawbacks: [
      'Distinctive earthy taste some dislike',
      'Less widely available',
      'Can trigger allergies in sensitive people',
      'Strong flavor dominates mild dishes'
    ],
    description: 'A gluten-free pseudo-grain that is a rare complete plant protein, rich in rutin.',
    serving: '100g'
  },
  {
    id: 'millet', name: 'Millet', emoji: '🌾', color: '#e6cf6a', calories: 119,
    nutrition: { protein: 3.5, carbs: 23, fat: 1, fiber: 1.3, manganese: 0.32, phosphorus: 100, magnesium: 38 },
    benefits: [
      'Gluten-free ancient grain',
      'Mildly alkaline-forming',
      'Supports heart health',
      'Gentle on blood sugar',
      'Easy to digest'
    ],
    drawbacks: [
      'Contains goitrogens that may affect the thyroid',
      'Low in the amino acid lysine',
      'Not widely known or used',
      'Bland flavor on its own'
    ],
    description: 'A tiny gluten-free ancient grain — alkaline-forming and gentle to digest.',
    serving: '100g'
  },
  {
    id: 'barley', name: 'Barley', emoji: '🌾', color: '#d8c89a', calories: 123,
    nutrition: { protein: 2.3, carbs: 28, fat: 0.4, fiber: 3.8, selenium: 6.05, manganese: 0.25, phosphorus: 60 },
    benefits: [
      'Beta-glucan fiber lowers cholesterol like oats',
      'Very high in dietary fiber',
      'Helps control blood sugar',
      'Supports gut and digestive health',
      'Promotes heart health'
    ],
    drawbacks: [
      'Contains gluten',
      'Phytic acid reduces mineral absorption',
      'High in carbohydrates',
      'Requires long cooking time'
    ],
    description: 'A chewy whole grain whose beta-glucan fiber actively lowers cholesterol.',
    serving: '100g'
  },
  {
    id: 'tuna', name: 'Tuna', emoji: '🐟', color: '#c8554d', calories: 116,
    nutrition: { protein: 26, carbs: 0, fat: 1, fiber: 0, vitaminB12: 1.97, selenium: 41.8, niacin: 8.64, vitaminD: 112 },
    benefits: [
      'Extremely high protein with minimal fat',
      'Naturally low in fat',
      'Contains heart-healthy omega-3 fatty acids',
      'Supports brain health and cognition',
      'Affordable and shelf-stable'
    ],
    drawbacks: [
      'Mercury content limits frequency',
      'Canned versions often high in sodium',
      'Overfishing and sustainability concerns',
      'Not recommended in large amounts for pregnant women'
    ],
    description: 'A lean, protein-dense fish loaded with B12 and selenium.',
    serving: '100g'
  },
  {
    id: 'turkey', name: 'Turkey Breast', emoji: '🦃', color: '#e8c4a0', calories: 135,
    nutrition: { protein: 30, carbs: 0, fat: 1, fiber: 0, vitaminB6: 0.99, vitaminB12: 0.58, selenium: 25.3, niacin: 8 },
    benefits: [
      'One of the leanest high-protein meats',
      'Tryptophan supports sleep and mood',
      'Very low in fat',
      'Rich in B vitamins for energy metabolism',
      'Excellent for weight management'
    ],
    drawbacks: [
      'Dries out easily if overcooked',
      'Milder flavor than chicken',
      'Often most available seasonally'
    ],
    description: 'The leanest of the poultry proteins — high protein with almost no fat.',
    serving: '100g'
  },
  {
    id: 'cottagecheese', name: 'Cottage Cheese', emoji: '🧀', color: '#f5f3ee', calories: 98,
    nutrition: { protein: 11, carbs: 3.4, fat: 4.3, fiber: 0, vitaminB12: 0.38, selenium: 7.7, calcium: 80, phosphorus: 160 },
    benefits: [
      'High in slow-release casein protein',
      'Ideal for overnight muscle recovery',
      'Low in calories for the protein it delivers',
      'Supports gut health',
      'Extremely versatile in the kitchen'
    ],
    drawbacks: [
      'Often high in sodium',
      'Problematic for the lactose intolerant',
      'Bland on its own',
      'Short refrigerated shelf life'
    ],
    description: 'A curd cheese rich in slow-digesting casein — perfect for overnight recovery.',
    serving: '100g'
  },
  {
    id: 'beef', name: 'Beef', emoji: '🥩', color: '#8b3a2f', calories: 250,
    nutrition: { protein: 26, carbs: 0, fat: 17, fiber: 0, vitaminB12: 2.35, zinc: 6.27, iron: 2.7, selenium: 16.5, niacin: 4.8 },
    benefits: [
      'Complete protein with all essential amino acids',
      'One of the richest food sources of B12',
      'High in bioavailable zinc and iron',
      'Excellent for muscle building',
      'Natural source of creatine'
    ],
    drawbacks: [
      'High in saturated fat',
      'Significant environmental footprint',
      'Excess linked to colorectal cancer risk',
      'More expensive than poultry'
    ],
    description: 'A complete protein and the richest everyday source of B12, zinc, and iron.',
    serving: '100g'
  },
  {
    id: 'pork', name: 'Pork Tenderloin', emoji: '🥓', color: '#e0a99a', calories: 143,
    nutrition: { protein: 26, carbs: 0, fat: 3.5, fiber: 0, thiamine: 0.65, vitaminB6: 0.63, vitaminB12: 0.43, selenium: 22, niacin: 6.24 },
    benefits: [
      'Lean cut with high-quality protein',
      'Highest thiamine of any meat',
      'Supports muscle building',
      'Rich in energy-releasing B vitamins',
      'One of the leanest pork cuts'
    ],
    drawbacks: [
      'Must be fully cooked (trichinosis risk)',
      'Less popular than other cuts',
      'Costs more than chicken'
    ],
    description: 'A lean pork cut with the highest thiamine content of any meat.',
    serving: '100g'
  },
  {
    id: 'shrimp', name: 'Shrimp', emoji: '🦐', color: '#f08070', calories: 99,
    nutrition: { protein: 24, carbs: 0.2, fat: 0.3, fiber: 0, selenium: 26.4, vitaminB12: 0.38, iodine: 52.5, phosphorus: 200 },
    benefits: [
      'Very high protein for very few calories',
      'Extremely low in fat',
      'Iodine supports thyroid function',
      'Contains the antioxidant astaxanthin',
      'Naturally low calorie'
    ],
    drawbacks: [
      'High in dietary cholesterol',
      'Common shellfish allergen',
      'Farming can carry environmental concerns',
      'Highly perishable'
    ],
    description: 'A lean shellfish delivering big protein and thyroid-supporting iodine for few calories.',
    serving: '100g'
  },
  {
    id: 'whey', name: 'Whey Protein', emoji: '🥛', color: '#f0ede6', calories: 400,
    nutrition: { protein: 80, carbs: 8, fat: 5, fiber: 0, calcium: 200, riboflavin: 0.33, vitaminB12: 0.72, leucine: 8 },
    benefits: [
      'Fastest-absorbing protein source',
      'Powerful trigger for muscle protein synthesis',
      'Complete amino acid profile',
      'Ideal for post-workout recovery',
      'Convenient and concentrated'
    ],
    drawbacks: [
      'A processed supplement, not whole food',
      'Can cause issues for the lactose intolerant',
      'Relatively expensive per serving',
      'May cause digestive discomfort in some'
    ],
    description: 'The gold-standard fast protein — concentrated, complete, and leucine-rich.',
    serving: '100g'
  },
  {
    id: 'edamame', name: 'Edamame', emoji: '🫛', color: '#7cb342', calories: 121,
    nutrition: { protein: 11, carbs: 8.9, fat: 5.2, fiber: 5.2, folate: 312, vitaminK: 31.2, manganese: 1.1, iron: 2.34 },
    benefits: [
      'A complete plant protein',
      'Very high folate supports pregnancy',
      'Isoflavones may support hormone balance',
      'Rich in dietary fiber',
      'Packed with antioxidants'
    ],
    drawbacks: [
      'Common soy allergen',
      'Phytoestrogen content concerns some',
      'Much soy is genetically modified',
      'Contains antinutrients'
    ],
    description: 'Young soybeans — a complete plant protein exceptionally high in folate.',
    serving: '100g'
  },
  {
    id: 'sardines', name: 'Sardines', emoji: '🐠', color: '#c0c4cc', calories: 208,
    nutrition: { protein: 25, carbs: 0, fat: 11, fiber: 0, vitaminB12: 3.58, selenium: 28.6, calcium: 380, vitaminD: 96, omega3: 1.5 },
    benefits: [
      'One of the richest B12 sources',
      'Edible bones make them rich in calcium and D',
      'High in anti-inflammatory omega-3',
      'A sustainable, low-mercury fish',
      'Inexpensive and shelf-stable'
    ],
    drawbacks: [
      'Strong smell and flavor',
      'Canned versions can be high in sodium',
      'Soft edible bones unappealing to some',
      'An acquired taste'
    ],
    description: 'A tiny powerhouse fish — extraordinary B12 plus calcium and D from edible bones.',
    serving: '100g'
  },
  {
    id: 'tempeh', name: 'Tempeh', emoji: '🧆', color: '#b08850', calories: 193,
    nutrition: { protein: 19, carbs: 9.4, fat: 11, fiber: 0, manganese: 1.24, phosphorus: 210, magnesium: 58.8, riboflavin: 0.18 },
    benefits: [
      'A complete fermented plant protein',
      'Probiotics from fermentation support gut health',
      'Firm, satisfying meat alternative',
      'Good source of calcium',
      'More digestible than unfermented soy'
    ],
    drawbacks: [
      'Common soy allergen',
      'An acquired, nutty flavor',
      'Less widely available',
      'Contains phytoestrogens'
    ],
    description: 'A firm fermented-soy cake — a complete plant protein with gut-friendly probiotics.',
    serving: '100g'
  },
  {
    id: 'lamb', name: 'Lamb', emoji: '🐑', color: '#9b3b30', calories: 294,
    nutrition: { protein: 25, carbs: 0, fat: 21, fiber: 0, vitaminB12: 1.87, zinc: 5.06, iron: 2.16, selenium: 14.3, niacin: 4 },
    benefits: [
      'Rich in B12 and bioavailable zinc',
      'Complete protein for muscle building',
      'Contains beneficial CLA fatty acid',
      'Good source of heme iron',
      'Highly satiating'
    ],
    drawbacks: [
      'High in saturated fat',
      'Strong, gamey flavor',
      'Expensive cut of meat',
      'High in calories'
    ],
    description: 'A rich red meat packed with B12, zinc, and the beneficial fatty acid CLA.',
    serving: '100g'
  },
  {
    id: 'cannedsalmon', name: 'Canned Salmon', emoji: '🥫', color: '#f08a5d', calories: 139,
    nutrition: { protein: 21, carbs: 0, fat: 6.1, fiber: 0, vitaminB12: 3.19, vitaminD: 728, selenium: 19.8, omega3: 1.2, calcium: 180 },
    benefits: [
      'Exceptionally high in vitamin D and B12',
      'Rich in anti-inflammatory omega-3',
      'Soft edible bones add calcium',
      'Far cheaper than fresh salmon',
      'Convenient and shelf-stable'
    ],
    drawbacks: [
      'Often high in sodium',
      'Cans may contain BPA',
      'Less appealing than fresh',
      'Softer, flakier texture'
    ],
    description: 'An affordable pantry protein with sky-high vitamin D and B12.',
    serving: '100g'
  },
  {
    id: 'tofu', name: 'Tofu', emoji: '🧈', color: '#f5f2e8', calories: 144,
    nutrition: { protein: 17, carbs: 3, fat: 8.7, fiber: 0.3, calcium: 350, manganese: 0.71, selenium: 7.7, iron: 2.7 },
    benefits: [
      'A complete plant protein',
      'One of the highest plant calcium sources',
      'Extremely versatile in cooking',
      'Supports heart health',
      'Contains beneficial isoflavones'
    ],
    drawbacks: [
      'Common soy allergen',
      'Contains phytoestrogens',
      'Bland without seasoning',
      'Contains some antinutrients'
    ],
    description: 'A versatile soy curd — a complete plant protein and a top plant calcium source.',
    serving: '100g'
  },
  {
    id: 'octopus', name: 'Octopus', emoji: '🐙', color: '#c97a8e', calories: 164,
    nutrition: { protein: 30, carbs: 4.4, fat: 2.1, fiber: 0, vitaminB12: 12.24, iron: 9.18, selenium: 38.5, copper: 0.9 },
    benefits: [
      'Extraordinary B12 content',
      'Very lean, high-quality protein',
      'Copper supports brain and nerve function',
      'Rich in iron',
      'Naturally low in fat'
    ],
    drawbacks: [
      'Chewy texture if poorly cooked',
      'Expensive',
      'Tricky to prepare well',
      'Raises ethical concerns for some'
    ],
    description: 'A lean cephalopod protein with off-the-charts B12 and brain-supporting copper.',
    serving: '100g'
  },
  {
    id: 'duck', name: 'Duck Breast', emoji: '🦆', color: '#8a4a3a', calories: 201,
    nutrition: { protein: 19, carbs: 0, fat: 13, fiber: 0, vitaminB12: 0.5, iron: 3.06, zinc: 1.65, selenium: 11, vitaminB6: 0.31 },
    benefits: [
      'Rich, flavorful protein',
      'Good source of heme iron',
      'Zinc supports immune function',
      'Provides a range of B vitamins',
      'Deeply satisfying and satiating'
    ],
    drawbacks: [
      'High in fat, mostly in the skin',
      'Expensive',
      'Less commonly cooked at home',
      'Higher calorie than chicken'
    ],
    description: 'A rich, flavorful poultry protein with good iron and immune-supporting zinc.',
    serving: '100g'
  },
  {
    id: 'hempseeds', name: 'Hemp Seeds', emoji: '🌱', color: '#b5b08a', calories: 553,
    nutrition: { protein: 31, carbs: 8.7, fat: 49, fiber: 4, manganese: 8.33, phosphorus: 830, magnesium: 294, omega3: 8.7 },
    benefits: [
      'A complete plant protein',
      'Near-perfect omega 3-to-6 ratio',
      'Supports heart health',
      'Easy to digest',
      'Contains all essential amino acids'
    ],
    drawbacks: [
      'Very high in calories',
      'Relatively expensive',
      'Distinct earthy flavor',
      'Very high fat content'
    ],
    description: 'Tiny complete-protein seeds with an ideal omega-3 to omega-6 balance.',
    serving: '100g'
  },
  {
    id: 'pumpkinseeds', name: 'Pumpkin Seeds', emoji: '🎃', color: '#c5d18a', calories: 559,
    nutrition: { protein: 30, carbs: 10.7, fat: 49, fiber: 6, manganese: 5.22, phosphorus: 920, magnesium: 386, zinc: 7.59, iron: 8.1 },
    benefits: [
      'Among the richest food sources of magnesium',
      'Tryptophan supports sleep',
      'Zinc supports prostate and immune health',
      'High in plant iron',
      'Support heart health'
    ],
    drawbacks: [
      'Very high in calories',
      'High fat content',
      'Easy to overeat',
      'Can be expensive'
    ],
    description: 'Crunchy green seeds that are one of nature\'s richest sources of magnesium.',
    serving: '100g'
  },
  {
    id: 'beefliver', name: 'Beef Liver', emoji: '🫀', color: '#6b3528', calories: 175,
    nutrition: { protein: 27, carbs: 5, fat: 5, fiber: 0, vitaminB12: 83.04, copper: 12.47, vitaminA: 7740, folate: 260, iron: 7.02 },
    benefits: [
      'Among the most nutrient-dense foods on earth',
      'Astronomical B12 content',
      'Extraordinarily rich in copper and vitamin A',
      'A complete, high-quality protein',
      'Loaded with bioavailable iron'
    ],
    drawbacks: [
      'Very strong, distinctive flavor',
      'Vitamin A toxicity risk if eaten daily',
      'High in cholesterol',
      'Filters toxins as the body\'s detox organ'
    ],
    description: 'Arguably the most nutrient-dense food on earth — staggering B12, copper, and vitamin A.',
    serving: '100g'
  },
  {
    id: 'mussels', name: 'Mussels', emoji: '🦪', color: '#3a4a6b', calories: 172,
    nutrition: { protein: 24, carbs: 7.4, fat: 4.5, fiber: 0, vitaminB12: 8.16, selenium: 52.8, manganese: 5.7, iron: 6.66, omega3: 0.7 },
    benefits: [
      'Extraordinary B12 and selenium content',
      'One of the most sustainable seafoods',
      'Contains anti-inflammatory omega-3',
      'Rich in iron',
      'High protein for low calories'
    ],
    drawbacks: [
      'Common shellfish allergen',
      'Filter feeders can accumulate toxins',
      'Strong oceanic taste',
      'Very perishable'
    ],
    description: 'A sustainable shellfish delivering massive B12, selenium, and manganese.',
    serving: '100g'
  },
  {
    id: 'spirulina', name: 'Spirulina', emoji: '🌀', color: '#1a6b5a', calories: 290,
    nutrition: { protein: 57, carbs: 24, fat: 7.7, fiber: 3.6, riboflavin: 2.77, iron: 28.4, copper: 0.77, thiamine: 2.48, gla: 1.3 },
    benefits: [
      'The highest protein density of any food',
      'A complete protein with all amino acids',
      'Supports the body\'s detox pathways',
      'Powerfully anti-inflammatory',
      'A nutrient-dense superfood'
    ],
    drawbacks: [
      'Strong taste and smell',
      'Contamination risk if poorly sourced',
      'Expensive',
      'Not widely available'
    ],
    description: 'A blue-green algae with the highest protein density of any known food.',
    serving: '100g'
  },
  {
    id: 'mango', name: 'Mango', emoji: '🥭', color: '#f5a623', calories: 60,
    nutrition: { protein: 0.8, carbs: 15, fat: 0.4, fiber: 1.6, vitaminC: 39.6, vitaminA: 486, vitaminB6: 0.15, folate: 44 },
    benefits: [
      'High in both vitamin C and vitamin A',
      'Contains digestive enzymes (amylase)',
      'Boosts immune function',
      'Carotenoids support eye health',
      'Anti-inflammatory polyphenols'
    ],
    drawbacks: [
      'High in natural sugar',
      'High glycemic index',
      'Can trigger allergies in sensitive people',
      'Higher calorie than many fruits'
    ],
    description: 'A lush tropical fruit rich in vitamins C and A plus digestive enzymes.',
    serving: '100g'
  },
  {
    id: 'pineapple', name: 'Pineapple', emoji: '🍍', color: '#e8c84a', calories: 50,
    nutrition: { protein: 0.5, carbs: 13, fat: 0.1, fiber: 1.4, vitaminC: 71.1, manganese: 1.01, vitaminB6: 0.12, thiamine: 0.07 },
    benefits: [
      'Bromelain enzyme aids protein digestion',
      'Anti-inflammatory properties',
      'Boosts immune function',
      'Manganese supports bone health',
      'Antioxidants support eye health'
    ],
    drawbacks: [
      'High in natural sugar',
      'Acidic — can erode tooth enamel',
      'Bromelain can irritate the mouth',
      'High glycemic for diabetics'
    ],
    description: 'A tangy tropical fruit packed with vitamin C and the digestive enzyme bromelain.',
    serving: '100g'
  },
  {
    id: 'strawberry', name: 'Strawberry', emoji: '🍓', color: '#e63946', calories: 32,
    nutrition: { protein: 0.7, carbs: 7.7, fat: 0.3, fiber: 2, vitaminC: 88.2, manganese: 0.41, folate: 24, vitaminK: 3.6 },
    benefits: [
      'Extremely high in vitamin C',
      'Supports heart health',
      'Helps regulate blood sugar',
      'Anti-inflammatory antioxidants',
      'Promotes healthy skin'
    ],
    drawbacks: [
      'High pesticide residue (a "dirty dozen" crop)',
      'Very short shelf life',
      'Mildly acidic',
      'Allergenic for some people'
    ],
    description: 'A vitamin-C powerhouse berry — one of the richest sources per calorie.',
    serving: '100g'
  },
  {
    id: 'watermelon', name: 'Watermelon', emoji: '🍉', color: '#f0506a', calories: 30,
    nutrition: { protein: 0.6, carbs: 7.6, fat: 0.2, fiber: 0.4, vitaminC: 11.7, vitaminA: 99, lycopene: 4.5, vitaminB6: 0.07 },
    benefits: [
      'Exceptionally hydrating (about 92% water)',
      'Lycopene antioxidant supports heart health',
      'L-citrulline may aid muscle recovery',
      'Very low in calories',
      'Naturally cooling and refreshing'
    ],
    drawbacks: [
      'Very high glycemic index',
      'Low in fiber',
      'High in natural sugar',
      'Can cause bloating in some'
    ],
    description: 'The ultimate hydrating fruit — 92% water with heart-healthy lycopene.',
    serving: '100g'
  },
  {
    id: 'grapes', name: 'Grapes', emoji: '🍇', color: '#6b3fa0', calories: 69,
    nutrition: { protein: 0.7, carbs: 18, fat: 0.2, fiber: 0.9, vitaminK: 16.8, vitaminC: 5.4, vitaminB6: 0.09, resveratrol: 2 },
    benefits: [
      'Resveratrol is a powerful antioxidant',
      'Supports heart health',
      'Anti-aging polyphenols',
      'Supports brain health',
      'May help with cancer prevention'
    ],
    drawbacks: [
      'High in natural sugar',
      'Low in fiber',
      'High glycemic index',
      'High pesticide residue',
      'Very easy to overeat'
    ],
    description: 'Bite-sized antioxidant bombs rich in heart-protective resveratrol.',
    serving: '100g'
  },
  {
    id: 'peach', name: 'Peach', emoji: '🍑', color: '#f5b08a', calories: 39,
    nutrition: { protein: 0.9, carbs: 9.5, fat: 0.3, fiber: 1.5, vitaminC: 9.9, vitaminA: 54, vitaminK: 6, niacin: 0.8 },
    benefits: [
      'Low in calories',
      'Provides vitamins C and A',
      'Supports healthy skin',
      'Aids digestion with fiber',
      'Contains protective antioxidants'
    ],
    drawbacks: [
      'Short growing season',
      'Bruises very easily',
      'Moderate sugar content',
      'High pesticide residue'
    ],
    description: 'A juicy stone fruit with skin-supporting vitamins C and A.',
    serving: '100g'
  },
  {
    id: 'pear', name: 'Pear', emoji: '🍐', color: '#c8d44a', calories: 57,
    nutrition: { protein: 0.4, carbs: 15, fat: 0.1, fiber: 3.1, vitaminK: 4.8, vitaminC: 6.3, copper: 0.04, vitaminB6: 0.03 },
    benefits: [
      'High in fiber, especially pectin',
      'Supports gut health',
      'Anti-inflammatory flavonoids',
      'Supports heart health',
      'Low in calories for its size'
    ],
    drawbacks: [
      'High in natural sugar',
      'Low overall vitamin content',
      'High glycemic when very ripe',
      'Bruises easily'
    ],
    description: 'A high-fiber fruit loaded with gut-friendly pectin.',
    serving: '100g'
  },
  {
    id: 'orange', name: 'Orange', emoji: '🍊', color: '#f5921e', calories: 47,
    nutrition: { protein: 0.9, carbs: 12, fat: 0.1, fiber: 2.4, vitaminC: 79.2, folate: 32, thiamine: 0.1, potassium: 188 },
    benefits: [
      'Very high in vitamin C',
      'Strengthens the immune system',
      'Flavonoids support heart health',
      'Good source of folate',
      'Pectin fiber aids digestion'
    ],
    drawbacks: [
      'Acidic — can trigger reflux',
      'Higher sugar than vegetables',
      'Can erode tooth enamel',
      'Juicing strips the fiber'
    ],
    description: 'The classic immune-boosting citrus, brimming with vitamin C.',
    serving: '100g'
  },
  {
    id: 'pomegranate', name: 'Pomegranate', emoji: '🔴', color: '#b71c2b', calories: 83,
    nutrition: { protein: 1.7, carbs: 19, fat: 1.2, fiber: 4, vitaminK: 19.2, vitaminC: 10.8, folate: 40, punicalagins: 15 },
    benefits: [
      'Punicalagins are exceptionally powerful antioxidants',
      'Strongly anti-inflammatory',
      'Supports heart health',
      'May support memory and cognition',
      'Studied for anti-cancer properties'
    ],
    drawbacks: [
      'Expensive',
      'Messy and time-consuming to eat',
      'Can interact with medications like grapefruit',
      'High in natural sugar'
    ],
    description: 'Ruby arils packed with punicalagins — among the most potent food antioxidants.',
    serving: '100g'
  },
  {
    id: 'cherry', name: 'Cherry', emoji: '🍒', color: '#9b1c31', calories: 63,
    nutrition: { protein: 1.1, carbs: 16, fat: 0.2, fiber: 2.1, vitaminC: 10.8, vitaminK: 3.6, potassium: 235, anthocyanins: 30 },
    benefits: [
      'A natural source of melatonin for sleep',
      'Anti-inflammatory anthocyanins',
      'May help prevent gout',
      'Supports heart health',
      'Aids exercise recovery'
    ],
    drawbacks: [
      'High in natural sugar',
      'Very short season',
      'Expensive',
      'Pits must be removed'
    ],
    description: 'A sleep-supporting stone fruit rich in melatonin and anthocyanins.',
    serving: '100g'
  },
  {
    id: 'papaya', name: 'Papaya', emoji: '🟠', color: '#f5832a', calories: 43,
    nutrition: { protein: 0.5, carbs: 11, fat: 0.3, fiber: 1.7, vitaminC: 92.7, vitaminA: 198, folate: 40, vitaminK: 3.6, papain: 8 },
    benefits: [
      'Papain enzyme aids protein digestion',
      'Very high in vitamin C',
      'Carotenoids support eye health',
      'Anti-inflammatory properties',
      'Promotes healthy skin'
    ],
    drawbacks: [
      'Strong, musky smell',
      'Linked to latex allergy in some',
      'High in natural sugar',
      'Laxative effect in excess'
    ],
    description: 'A tropical fruit with the digestive enzyme papain and over a day of vitamin C.',
    serving: '100g'
  },
  {
    id: 'fig', name: 'Fig', emoji: '🟣', color: '#7a4a8c', calories: 74,
    nutrition: { protein: 0.8, carbs: 19, fat: 0.3, fiber: 2.9, vitaminK: 4.8, vitaminB6: 0.1, copper: 0.03, manganese: 0.14 },
    benefits: [
      'High in dietary fiber',
      'Supports bone health',
      'Helps control blood pressure',
      'Promotes digestive health',
      'Rich in antioxidants'
    ],
    drawbacks: [
      'Very high in natural sugar',
      'High glycemic index',
      'Calorie-dense, especially dried',
      'Very short fresh shelf life'
    ],
    description: 'A honeyed, fiber-rich fruit that supports bone health and digestion.',
    serving: '100g'
  },
  {
    id: 'raspberries', name: 'Raspberries', emoji: '🔴', color: '#d11e4a', calories: 52,
    nutrition: { protein: 1.2, carbs: 12, fat: 0.7, fiber: 6.5, vitaminC: 38.7, vitaminK: 8.4, manganese: 0.74, folate: 20 },
    benefits: [
      'One of the highest-fiber common fruits',
      'Ellagic acid studied for anti-cancer effects',
      'Helps regulate blood sugar',
      'Supports heart health',
      'Low in sugar for a fruit'
    ],
    drawbacks: [
      'Extremely fragile and perishable',
      'Expensive',
      'Seedy texture',
      'Very short shelf life'
    ],
    description: 'A delicate berry boasting more fiber than almost any other fruit.',
    serving: '100g'
  },
  {
    id: 'blackberries', name: 'Blackberries', emoji: '⚫', color: '#2e1a3a', calories: 43,
    nutrition: { protein: 1.4, carbs: 10, fat: 0.5, fiber: 5.3, vitaminK: 22.8, vitaminC: 31.5, manganese: 0.67, folate: 24 },
    benefits: [
      'Very high in dietary fiber',
      'Vitamin K supports bone health',
      'Anti-cancer anthocyanins',
      'Supports brain health',
      'Low in calories'
    ],
    drawbacks: [
      'Fragile and perishable',
      'Short shelf life',
      'Seedy texture',
      'Expensive out of season'
    ],
    description: 'A dark, antioxidant-rich berry high in fiber and bone-supporting vitamin K.',
    serving: '100g'
  },
  {
    id: 'apricot', name: 'Apricot', emoji: '🟧', color: '#f0a04a', calories: 48,
    nutrition: { protein: 1.4, carbs: 11, fat: 0.4, fiber: 2, vitaminA: 234, vitaminC: 10.8, vitaminK: 4.8, vitaminE: 0.9, betacarotene: 1090 },
    benefits: [
      'High in beta-carotene for eye health',
      'Supports healthy skin',
      'Potassium supports heart health',
      'Good source of fiber',
      'Low in calories'
    ],
    drawbacks: [
      'Short growing season',
      'Bruises easily',
      'Moderate sugar content',
      'Dried versions are much higher in sugar'
    ],
    description: 'A golden stone fruit loaded with eye-protecting beta-carotene.',
    serving: '100g'
  },
  {
    id: 'plum', name: 'Plum', emoji: '🟪', color: '#5e2a6b', calories: 46,
    nutrition: { protein: 0.7, carbs: 11, fat: 0.3, fiber: 1.4, vitaminC: 14.4, vitaminK: 7.2, vitaminA: 45, riboflavin: 0.04 },
    benefits: [
      'Sorbitol acts as a natural laxative',
      'Vitamin K supports bone health',
      'Rich in antioxidants',
      'Supports heart health',
      'Low in calories'
    ],
    drawbacks: [
      'Laxative effect in excess',
      'High in natural sugar',
      'Pesticide residue',
      'Short season'
    ],
    description: 'A juicy stone fruit with antioxidants and gentle digestive benefits.',
    serving: '100g'
  },
  {
    id: 'lychee', name: 'Lychee', emoji: '🌸', color: '#f06a8a', calories: 66,
    nutrition: { protein: 0.8, carbs: 17, fat: 0.4, fiber: 1.3, vitaminC: 107.1, vitaminB6: 0.14, copper: 0.08, potassium: 235 },
    benefits: [
      'Extremely high in vitamin C',
      'Oligonol antioxidant supports circulation',
      'Supports heart health',
      'Promotes healthy skin',
      'Boosts immune function'
    ],
    drawbacks: [
      'Very high in natural sugar',
      'Not widely available',
      'Unripe fruit can be toxic',
      'Short season'
    ],
    description: 'A fragrant tropical fruit with more vitamin C than an orange.',
    serving: '100g'
  },
  {
    id: 'passionfruit', name: 'Passion Fruit', emoji: '🟣', color: '#6b2a8c', calories: 97,
    nutrition: { protein: 2.2, carbs: 23, fat: 0.7, fiber: 10.4, vitaminA: 225, vitaminC: 27, iron: 2.16, potassium: 376 },
    benefits: [
      'Exceptionally high in dietary fiber',
      'Compounds with calming, sleep-supporting effects',
      'Boosts immune function',
      'Carotenoids support eye health',
      'Supports heart health'
    ],
    drawbacks: [
      'Very high in natural sugar',
      'Intensely sour taste',
      'Expensive',
      'Not widely available'
    ],
    description: 'A tart tropical fruit with extraordinary fiber and calming compounds.',
    serving: '100g'
  },
  {
    id: 'coconut', name: 'Coconut', emoji: '🥥', color: '#d8c8a8', calories: 354,
    nutrition: { protein: 3.3, carbs: 15, fat: 33, fiber: 9, manganese: 1.73, copper: 0.2, selenium: 7.7, iron: 2.34 },
    benefits: [
      'MCT fats provide quick energy',
      'Lauric acid has antimicrobial effects',
      'High in dietary fiber',
      'Supports ketone production for brain fuel',
      'Manganese supports metabolism'
    ],
    drawbacks: [
      'Very high in saturated fat',
      'Very calorie-dense',
      'Some health claims are overstated',
      'Fiber can slow digestion'
    ],
    description: 'A rich tropical fruit high in fiber and quick-energy MCT fats.',
    serving: '100g'
  },
  {
    id: 'dragonfruit', name: 'Dragon Fruit', emoji: '🐉', color: '#e84a8c', calories: 60,
    nutrition: { protein: 1.2, carbs: 13, fat: 0, fiber: 3, vitaminC: 8.1, iron: 1.44, magnesium: 29.4, betalains: 9 },
    benefits: [
      'Betalain antioxidants fight inflammation',
      'Prebiotic fiber supports gut health',
      'May enhance iron absorption',
      'Anti-inflammatory properties',
      'Low in calories'
    ],
    drawbacks: [
      'Expensive',
      'Mild, subtle flavor',
      'Short shelf life',
      'Limited availability'
    ],
    description: 'A striking tropical fruit with gut-friendly fiber and betalain antioxidants.',
    serving: '100g'
  }
];

app.get('/api/foods', (req, res) => res.json(foods));
app.get('/api/foods/:id', (req, res) => {
  const food = foods.find(f => f.id === req.params.id);
  food ? res.json(food) : res.status(404).json({ error: 'Food not found' });
});

// Match a free-text ingredient name to a food in the database
function matchFoodId(name) {
  const n = String(name).toLowerCase().trim();
  let f = foods.find(food => food.name.toLowerCase() === n);
  if (!f) f = foods.find(food => food.name.toLowerCase().includes(n) || n.includes(food.name.toLowerCase()));
  return f ? f.id : null;
}

// ─── AUTH ────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { email, password, name, age, weight, goal } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email and password are required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users = readJSON(USERS_FILE);
  if (users.find(u => u.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const user = {
    id: uuidv4(),
    email: String(email).trim().toLowerCase(),
    password: await bcrypt.hash(String(password), 10),
    name: String(name).trim(),
    age: age ? Number(age) : null,
    weight: weight ? Number(weight) : null,
    height: null,
    gender: null,
    goal: goal || 'maintain',
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeJSON(USERS_FILE, users);
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({ token, user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const users = readJSON(USERS_FILE);
  const user = users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user || !(await bcrypt.compare(String(password), user.password))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: publicUser(user) });
});

app.get('/api/profile', auth, (req, res) => {
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user), calories: calcCalories(user) });
});

app.put('/api/profile', auth, (req, res) => {
  const users = readJSON(USERS_FILE);
  const idx = users.findIndex(u => u.id === req.userId);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const u = users[idx];
  const { name, age, weight, currentWeight, targetWeight, height, gender, goal, timeline, activityLevel } = req.body || {};
  if (name != null) u.name = String(name).trim();
  if (age != null) u.age = Number(age);
  const cw = currentWeight != null ? currentWeight : weight;
  if (cw != null) u.weight = Number(cw);
  if (targetWeight != null) u.targetWeight = Number(targetWeight);
  if (height != null) u.height = Number(height);
  if (gender != null) u.gender = String(gender);
  if (timeline != null) u.timeline = Number(timeline);
  if (activityLevel != null) u.activityLevel = String(activityLevel);
  // Derive goal from target vs current weight (falls back to explicit goal)
  if (u.targetWeight != null && u.weight != null) {
    u.goal = u.targetWeight < u.weight - 0.05 ? 'lose_weight'
      : u.targetWeight > u.weight + 0.05 ? 'gain_muscle' : 'maintain';
  } else if (goal != null) {
    u.goal = String(goal);
  }
  users[idx] = u;
  writeJSON(USERS_FILE, users);
  res.json({ user: publicUser(u), calories: calcCalories(u) });
});

// ─── PROFILE STATS ────────────────────────────────────────────────────────
app.get('/api/profile/stats', auth, (req, res) => {
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const cal = calcCalories(user);
  if (!cal) return res.status(400).json({ error: 'Profile incomplete — fill in your stats first.' });
  const bmi = user.height ? +(user.weight / Math.pow(user.height / 100, 2)).toFixed(1) : null;
  res.json({
    bmi,
    bmr: cal.bmr,
    tdee: cal.tdee,
    dailyCalories: cal.target,
    weeklyLoss: +Math.abs(cal.weeklyChange).toFixed(2),
    weeksRemaining: cal.effWeeks,
    progressPercent: 0,
    estimatedCompletion: cal.completionDate,
    direction: cal.direction,
    goalKg: cal.goalKg,
    currentWeight: cal.currentWeight,
    targetWeight: cal.targetWeight,
    activityMultiplier: cal.activityMultiplier,
    macros: { protein: cal.protein, carbs: cal.carbs, fats: cal.fats },
    prediction: cal.prediction,
    warning: cal.warning,
  });
});

// ─── FRIDGE ──────────────────────────────────────────────────────────────
app.get('/api/fridge', auth, (req, res) => {
  res.json(readJSON(FRIDGES_FILE).filter(i => i.userId === req.userId));
});

app.post('/api/fridge', auth, (req, res) => {
  const { name, quantity, category, foodId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Ingredient name is required' });
  const fridges = readJSON(FRIDGES_FILE);
  const item = {
    id: uuidv4(),
    userId: req.userId,
    name: String(name).trim(),
    quantity: quantity ? String(quantity).trim() : '100g',
    category: category || 'protein',
    foodId: foodId || matchFoodId(name),
    addedAt: new Date().toISOString(),
  };
  fridges.push(item);
  writeJSON(FRIDGES_FILE, fridges);
  res.status(201).json(item);
});

app.put('/api/fridge/:id', auth, (req, res) => {
  const fridges = readJSON(FRIDGES_FILE);
  const item = fridges.find(i => i.id === req.params.id && i.userId === req.userId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const { quantity, category } = req.body || {};
  if (quantity != null) item.quantity = String(quantity).trim();
  if (category != null) item.category = String(category);
  writeJSON(FRIDGES_FILE, fridges);
  res.json(item);
});

app.delete('/api/fridge/:id', auth, (req, res) => {
  let fridges = readJSON(FRIDGES_FILE);
  const before = fridges.length;
  fridges = fridges.filter(i => !(i.id === req.params.id && i.userId === req.userId));
  if (fridges.length === before) return res.status(404).json({ error: 'Item not found' });
  writeJSON(FRIDGES_FILE, fridges);
  res.json({ success: true });
});

// ─── MEAL PLAN ─────────────────────────────────────────────────────────────
function buildMeal(name, time, targetCal, picks) {
  const verbs = {
    Breakfast: 'Prepare', Lunch: 'Cook and combine', Dinner: 'Lightly cook and plate', Snacks: 'Enjoy',
  };
  const per = picks.length ? targetCal / picks.length : 0;
  const items = picks.map(food => {
    const grams = Math.min(400, Math.max(20, Math.round((per / (food.calories || 1)) * 100)));
    const factor = grams / 100;
    return {
      foodId: food.id, name: food.name, emoji: food.emoji,
      quantity: grams + 'g',
      calories: Math.round(food.calories * factor),
      protein: +(food.nutrition.protein * factor).toFixed(1),
      carbs: +(food.nutrition.carbs * factor).toFixed(1),
      fat: +(food.nutrition.fat * factor).toFixed(1),
    };
  });
  const tot = items.reduce((a, it) => ({
    calories: a.calories + it.calories, protein: a.protein + it.protein,
    carbs: a.carbs + it.carbs, fat: a.fat + it.fat,
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  const names = items.map(i => i.name);
  const instructions = items.length
    ? `${verbs[name]} ${names.join(', ').replace(/, ([^,]*)$/, ' and $1')} (${items.map(i => i.quantity).join(', ')}).`
    : 'Add more ingredients to your fridge for a richer plan.';
  return {
    name, time, instructions, items,
    calories: tot.calories,
    protein: +tot.protein.toFixed(1),
    carbs: +tot.carbs.toFixed(1),
    fat: +tot.fat.toFixed(1),
  };
}

function buildPlan(allFoods, cal, offset) {
  const pick = (start, count) => {
    const out = [];
    for (let k = 0; k < count && allFoods.length; k++) out.push(allFoods[(start + k) % allFoods.length]);
    return out;
  };
  const o = offset || 0;
  const meals = [
    buildMeal('Breakfast', '08:00', Math.round(cal.target * 0.25), pick(o + 0, Math.min(2, allFoods.length))),
    buildMeal('Lunch', '13:00', Math.round(cal.target * 0.35), pick(o + 2, Math.min(3, allFoods.length))),
    buildMeal('Dinner', '19:00', Math.round(cal.target * 0.30), pick(o + 5, Math.min(3, allFoods.length))),
    buildMeal('Snacks', '16:00', Math.round(cal.target * 0.10), pick(o + 8, Math.min(1, allFoods.length))),
  ];
  const totals = meals.reduce((a, m) => ({
    calories: a.calories + m.calories, protein: a.protein + m.protein,
    carbs: a.carbs + m.carbs, fat: a.fat + m.fat,
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  return {
    meals,
    target: cal,
    totals: {
      calories: totals.calories,
      protein: +totals.protein.toFixed(1),
      carbs: +totals.carbs.toFixed(1),
      fat: +totals.fat.toFixed(1),
    },
    generatedAt: new Date().toISOString(),
  };
}

function setUserPlan(userId, plan, saved) {
  const all = readJSON(MEALPLANS_FILE);
  const idx = all.findIndex(p => p.userId === userId);
  const rec = { userId, plan, saved: !!saved, updatedAt: new Date().toISOString() };
  if (idx === -1) all.push(rec); else all[idx] = rec;
  writeJSON(MEALPLANS_FILE, all);
}

app.post('/api/mealplan/generate', auth, (req, res) => {
  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const cal = calcCalories(user);
  if (!cal) return res.status(400).json({ error: 'Complete your profile (age, weight, height, gender) first' });

  const fridge = readJSON(FRIDGES_FILE).filter(i => i.userId === req.userId);
  if (!fridge.length) return res.status(400).json({ error: 'Your fridge is empty — add some ingredients first' });

  const resolved = fridge
    .map(i => foods.find(f => f.id === i.foodId) || foods.find(f => f.name.toLowerCase() === i.name.toLowerCase()))
    .filter(Boolean);
  if (!resolved.length) {
    return res.status(400).json({ error: 'None of your fridge items match the food database. Try common names like "Chicken Breast" or "Banana".' });
  }
  // rotate the starting offset each generation for variety
  const prev = readJSON(MEALPLANS_FILE).find(p => p.userId === req.userId);
  const offset = ((prev && prev.offset) || 0) + 1;
  const plan = buildPlan(resolved, cal, offset);

  const all = readJSON(MEALPLANS_FILE);
  const idx = all.findIndex(p => p.userId === req.userId);
  const rec = { userId: req.userId, plan, saved: false, offset, updatedAt: new Date().toISOString() };
  if (idx === -1) all.push(rec); else all[idx] = rec;
  writeJSON(MEALPLANS_FILE, all);

  res.json(plan);
});

app.get('/api/mealplan', auth, (req, res) => {
  const rec = readJSON(MEALPLANS_FILE).find(p => p.userId === req.userId);
  res.json(rec ? rec.plan : null);
});

app.post('/api/mealplan/save', auth, (req, res) => {
  const bodyPlan = req.body && req.body.plan;
  const existing = readJSON(MEALPLANS_FILE).find(p => p.userId === req.userId);
  const plan = bodyPlan || (existing && existing.plan);
  if (!plan) return res.status(400).json({ error: 'No meal plan to save — generate one first' });
  setUserPlan(req.userId, plan, true);
  res.json({ success: true, message: 'Meal plan saved' });
});

// ─── DAILY MEAL LOG (calorie tracker + weekly overview) ────────────────────
app.get('/api/logs', auth, (req, res) => {
  res.json(readJSON(LOGS_FILE).filter(l => l.userId === req.userId));
});

app.post('/api/logs', auth, (req, res) => {
  const { name, calories, protein, carbs, fat, date } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Meal name is required' });
  const logs = readJSON(LOGS_FILE);
  const entry = {
    id: uuidv4(),
    userId: req.userId,
    name: String(name).trim(),
    calories: Math.round(Number(calories) || 0),
    protein: +(Number(protein) || 0).toFixed(1),
    carbs: +(Number(carbs) || 0).toFixed(1),
    fat: +(Number(fat) || 0).toFixed(1),
    date: date || new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
  };
  logs.push(entry);
  writeJSON(LOGS_FILE, logs);
  res.status(201).json(entry);
});

app.delete('/api/logs/:id', auth, (req, res) => {
  let logs = readJSON(LOGS_FILE);
  const before = logs.length;
  logs = logs.filter(l => !(l.id === req.params.id && l.userId === req.userId));
  if (logs.length === before) return res.status(404).json({ error: 'Log not found' });
  writeJSON(LOGS_FILE, logs);
  res.json({ success: true });
});

// ─── AI CHAT (NutriAI) ─────────────────────────────────────────────────────
function buildSystemPrompt(user, fridge, cal) {
  const profile = user ? {
    name: user.name, age: user.age, gender: user.gender,
    currentWeight: user.weight, targetWeight: user.targetWeight, height: user.height,
    activityLevel: user.activityLevel, timelineWeeks: user.timeline, goal: user.goal,
  } : {};
  const fridgeList = fridge.map(i => ({ name: i.name, quantity: i.quantity, category: i.category }));
  const foodDb = foods.map(f => `${f.name} (${f.calories}kcal P${f.nutrition.protein} C${f.nutrition.carbs} F${f.nutrition.fat})`).join('; ');
  const target = cal ? `${cal.target} kcal/day` : 'not set (profile incomplete)';
  const macros = cal ? `Protein ${cal.protein}g, Carbs ${cal.carbs}g, Fats ${cal.fats}g` : 'not set';
  return `You are NutriAI, an expert nutrition and fitness assistant for NutriBase Georgia. You have access to the user's profile and fridge contents. Always be encouraging, scientific, and practical.

User Profile: ${JSON.stringify(profile)}
Fridge Contents: ${JSON.stringify(fridgeList)}
Daily Calorie Target: ${target}
Macro Targets: ${macros}
Available Foods Database (per 100g): ${foodDb}

Rules:
- Always base advice on the user's specific calorie and macro targets
- When suggesting meals, only use ingredients from their fridge
- Always show calories and macros for suggested meals
- Be encouraging but realistic about goals
- Keep responses concise and actionable
- Format meal suggestions clearly with quantities
- If asked about medical conditions, recommend doctor consultation`;
}

// Smart rule-based assistant used when no Gemini API key is configured (or the API errors)
function fallbackReply(message, user, fridge, cal) {
  const m = String(message).toLowerCase();
  const name = user && user.name ? user.name.split(' ')[0] : 'there';
  const t = cal ? cal.target : null;
  const names = fridge.map(f => f.name);
  const has = names.length ? names.join(', ') : 'nothing yet';
  const noKey = genAI ? '' : '\n\n_(Tip: add a real GEMINI_API_KEY to .env for full conversational AI — these are smart built-in answers.)_';

  if (/protein/.test(m)) {
    return cal
      ? `Based on your ${t} kcal/day target, aim for about **${cal.protein}g of protein** daily (~${(cal.protein / (user.weight || 70)).toFixed(1)}g per kg). Spread it out — eggs at breakfast, chicken/fish at lunch & dinner, Greek yogurt as a snack.${noKey}`
      : `Complete your profile and I'll calculate your exact protein target.${noKey}`;
  }
  if (/(how many )?calorie|target|tdee/.test(m)) {
    return cal
      ? `Your personalized target is **${t} kcal/day** — a ${cal.direction === 'lose' ? 'deficit' : cal.direction === 'gain' ? 'surplus' : 'maintenance'} of ${Math.abs(cal.dailyAdjust)} cal vs your TDEE of ${cal.tdee}. Macros: ${cal.protein}g P / ${cal.carbs}g C / ${cal.fats}g F.${noKey}`
      : `Finish your profile (weight, height, age, activity, goal) and I'll compute your exact target.${noKey}`;
  }
  if (/meal plan|plan for (today|the day)|day plan|1\d{3}\s*cal/.test(m)) {
    if (!fridge.length) return `Your fridge is empty, ${name}! Add a few ingredients and I'll build a full day around your ${t || 'daily'} kcal target. Use the **Generate Meal Plan** button once stocked.${noKey}`;
    return `From your fridge (${has}) for a ${t || ''} kcal day:\n• **Breakfast** — ${names[0] || 'eggs'}\n• **Lunch** — ${names[1] || names[0]}\n• **Dinner** — ${names[2] || names[0]}\n• **Snack** — ${names[3] || names[0]}\nHit **Generate Meal Plan** for exact portions and macros!${noKey}`;
  }
  if (/cook|make with|recipe|what can i (eat|make|cook)|20 min|quick/.test(m)) {
    return fridge.length
      ? `With ${has}, build a plate of protein + carb + veg. A quick option: ${names.slice(0, 2).join(' + ') || 'your items'} — ready in ~15 min. Tap **Generate Meal Plan** for portioned macros.${noKey}`
      : `Add a few ingredients first, then I'll suggest recipes you can actually make with what you have.${noKey}`;
  }
  if (/give up|quit|too hard|can.?t do|motivat|hate this/.test(m)) {
    return `Don't give up, ${name}! ${cal && cal.goalKg ? `You're aiming to ${cal.direction} ${cal.goalKg}kg — totally achievable at a healthy pace.` : ''} Progress isn't linear; consistency beats perfection. One good choice at a time. 💪${noKey}`;
  }
  if (/realistic|how long|when will|see results|results/.test(m)) {
    return cal && cal.completionDate
      ? `At a safe pace you'd hit your goal around **${cal.completionDate}** (~${cal.effWeeks} weeks), changing about ${Math.abs(cal.weeklyChange)}kg/week. Visible results usually show in 3-4 weeks. Stay consistent!${noKey}`
      : `Set a target weight and timeline in your profile and I'll project your completion date.${noKey}`;
  }
  if (/cheat|ate too much|over\s?ate|already ate|slipped/.test(m)) {
    return `No worries — one meal won't undo your progress. Get back on track at your next meal, hit your ${t || 'daily'} target tomorrow, drink water, and add a walk if you can. You've got this.${noKey}`;
  }
  if (/rice|carb|sugar|bread|good for/.test(m)) {
    return `Carbs aren't the enemy — they fuel training and recovery. For ${cal && cal.direction === 'lose' ? 'fat loss' : 'your goal'}, keep portions aligned to your ${cal ? cal.carbs + 'g' : 'daily'} carb target and favor whole sources (rice, oats, sweet potato) over refined ones.${noKey}`;
  }
  return `Hi ${name}! I'm **NutriAI**. I can suggest meals from your fridge (${has}), explain your ${t ? t + ' kcal' : ''} targets, and answer nutrition questions. Try: "make me a meal plan", "how much protein do I need?", or "what can I cook?"${noKey}`;
}

app.post('/api/ai/chat', auth, async (req, res) => {
  const { message, history } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required' });

  const user = readJSON(USERS_FILE).find(u => u.id === req.userId);
  const fridge = readJSON(FRIDGES_FILE).filter(i => i.userId === req.userId);
  const cal = calcCalories(user);

  if (!genAI) {
    return res.json({ reply: fallbackReply(message, user, fridge, cal), fallback: true });
  }
  try {
    const model = genAI.getGenerativeModel({
      // gemini-1.5-flash is retired (404) on this key; gemini-2.5-flash is the
      // current free-tier flash model with available quota. Override via GEMINI_MODEL.
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      systemInstruction: buildSystemPrompt(user, fridge, cal),
    });
    // Gemini requires history to start with a 'user' turn; include prior turns as context text
    const prior = Array.isArray(history) ? history.slice(-10) : [];
    const convo = prior
      .map(h => `${h.role === 'assistant' ? 'NutriAI' : 'User'}: ${String(h.content)}`)
      .join('\n');
    const prompt = (convo ? convo + '\n' : '') + 'User: ' + String(message);
    const result = await model.generateContent(prompt);
    const reply = (result.response.text() || '').trim();
    res.json({ reply: reply || fallbackReply(message, user, fridge, cal) });
  } catch (err) {
    res.json({ reply: fallbackReply(message, user, fridge, cal), fallback: true, note: 'AI service temporarily unavailable' });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Healthy Food DB running at http://localhost:${PORT}`));
