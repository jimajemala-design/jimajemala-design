const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const foods = [
  {
    id: 'apple',
    name: 'Apple',
    emoji: '🍎',
    color: '#e74c3c',
    calories: 95,
    nutrition: { protein: 0.5, carbs: 25, fat: 0.3, fiber: 4.4, sugar: 19, vitaminC: 14 },
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
    serving: '1 medium (182g)'
  },
  {
    id: 'banana',
    name: 'Banana',
    emoji: '🍌',
    color: '#f1c40f',
    calories: 105,
    nutrition: { protein: 1.3, carbs: 27, fat: 0.4, fiber: 3.1, sugar: 14, potassium: 422 },
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
    serving: '1 medium (118g)'
  },
  {
    id: 'chicken',
    name: 'Chicken Breast',
    emoji: '🍗',
    color: '#f39c12',
    calories: 165,
    nutrition: { protein: 31, carbs: 0, fat: 3.6, fiber: 0, sodium: 74, vitaminB12: 0.3 },
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
    serving: '100g cooked'
  },
  {
    id: 'fish',
    name: 'Fish (Salmon)',
    emoji: '🐟',
    color: '#e67e22',
    calories: 208,
    nutrition: { protein: 20, carbs: 0, fat: 13, fiber: 0, omega3: 2.3, vitaminD: 447 },
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
    serving: '100g cooked'
  },
  {
    id: 'almond',
    name: 'Almond',
    emoji: '🥜',
    color: '#8B6914',
    calories: 164,
    nutrition: { protein: 6, carbs: 6, fat: 14, fiber: 3.5, vitaminE: 7.3, magnesium: 76 },
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
    serving: '28g (about 23 almonds)'
  },
  {
    id: 'egg',
    name: 'Eggs',
    emoji: '🥚',
    color: '#F5E6C8',
    calories: 70,
    nutrition: { protein: 6, carbs: 0.6, fat: 5, fiber: 0, vitaminB12: 0.6, selenium: 15.4, choline: 147, sodium: 62 },
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
    serving: '1 large (50g)'
  },
  {
    id: 'sweetpotato',
    name: 'Sweet Potato',
    emoji: '🍠',
    color: '#E8611A',
    calories: 103,
    nutrition: { protein: 2, carbs: 24, fat: 0.1, fiber: 3.9, vitaminA: 961, vitaminC: 19.6, potassium: 438, vitaminB6: 0.3, sodium: 41 },
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
    serving: '1 medium (130g)'
  },
  {
    id: 'broccoli', name: 'Broccoli', emoji: '🥦', color: '#22863a', calories: 55,
    nutrition: { protein: 3.7, carbs: 11, fiber: 5.1, fat: 0.6, vitaminC: 81, vitaminK: 92, folate: 57, vitaminA: 60 },
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
    serving: '1 cup (91g)'
  },
  {
    id: 'avocado', name: 'Avocado', emoji: '🥑', color: '#355e3b', calories: 160,
    nutrition: { protein: 2, carbs: 9, fiber: 7, fat: 15, vitaminK: 21, folate: 80, vitaminB6: 0.2, vitaminE: 1.5, potassium: 487 },
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
    serving: '1/2 medium (68g)'
  },
  {
    id: 'blueberry', name: 'Blueberries', emoji: '🫐', color: '#4b3b8c', calories: 84,
    nutrition: { protein: 1.1, carbs: 21, fiber: 3.6, fat: 0.5, vitaminC: 14, vitaminK: 29, manganese: 0.58 },
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
    serving: '1 cup (148g)'
  },
  {
    id: 'spinach', name: 'Spinach', emoji: '🥬', color: '#2d6a2f', calories: 7,
    nutrition: { protein: 0.9, carbs: 1.1, fiber: 0.7, fat: 0.1, vitaminK: 145, vitaminA: 281, folate: 58, vitaminC: 8 },
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
    serving: '1 cup raw (30g)'
  },
  {
    id: 'greekyogurt', name: 'Greek Yogurt', emoji: '🍦', color: '#f0ede6', calories: 100,
    nutrition: { protein: 17, carbs: 6, fiber: 0, fat: 0.7, vitaminB12: 0.5, calcium: 180, phosphorus: 105, riboflavin: 0.16 },
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
    serving: '170g container'
  },
  {
    id: 'carrot', name: 'Carrot', emoji: '🥕', color: '#f97316', calories: 25,
    nutrition: { protein: 0.6, carbs: 6, fiber: 1.7, fat: 0.1, vitaminA: 509, vitaminK: 8, vitaminB6: 0.09, biotin: 0.6 },
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
    serving: '1 medium (61g)'
  },
  {
    id: 'oats', name: 'Oats', emoji: '🥣', color: '#d4a853', calories: 166,
    nutrition: { protein: 5.9, carbs: 32, fiber: 4, fat: 3.6, manganese: 1.4, phosphorus: 126, magnesium: 56, zinc: 1.2 },
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
    serving: '1 cup cooked (234g)'
  },
  {
    id: 'lemon', name: 'Lemon', emoji: '🍋', color: '#fde047', calories: 17,
    nutrition: { protein: 0.6, carbs: 5.4, fiber: 1.6, fat: 0.2, vitaminC: 31, vitaminB6: 0.04, folate: 6 },
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
    serving: '1 fruit (58g)'
  },
  {
    id: 'walnut', name: 'Walnuts', emoji: '🫘', color: '#8b5e3c', calories: 185,
    nutrition: { protein: 4.3, carbs: 3.9, fiber: 1.9, fat: 18, omega3: 2.5, manganese: 0.96, copper: 0.37, magnesium: 44 },
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
    serving: '28g (14 halves)'
  },
  {
    id: 'tomato', name: 'Tomato', emoji: '🍅', color: '#dc2626', calories: 22,
    nutrition: { protein: 1.1, carbs: 4.8, fiber: 1.5, fat: 0.2, vitaminC: 17, vitaminK: 10, lycopene: 3.2, vitaminA: 42, potassium: 292 },
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
    serving: '1 medium (123g)'
  },
  {
    id: 'garlic', name: 'Garlic', emoji: '🧄', color: '#f5f0e0', calories: 13,
    nutrition: { protein: 0.6, carbs: 3, fiber: 0.2, fat: 0.05, manganese: 0.15, vitaminB6: 0.11, vitaminC: 2.8, allicin: 5 },
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
    serving: '3 cloves (9g)'
  },
  {
    id: 'darkchocolate', name: 'Dark Chocolate', emoji: '🍫', color: '#3d1a0a', calories: 170,
    nutrition: { protein: 2.2, carbs: 13, fiber: 3.1, fat: 12, magnesium: 64, copper: 0.5, manganese: 0.56, flavonoids: 138 },
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
    serving: '28g (1 oz square)'
  },
  {
    id: 'kiwi', name: 'Kiwi', emoji: '🥝', color: '#4d7c0f', calories: 42,
    nutrition: { protein: 0.8, carbs: 10, fiber: 2.1, fat: 0.4, vitaminC: 64, vitaminK: 28, vitaminE: 1.0, folate: 17 },
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
    serving: '1 medium (69g)'
  },
  {
    id: 'quinoa', name: 'Quinoa', emoji: '🌾', color: '#d4c5a0', calories: 222,
    nutrition: { protein: 8, carbs: 39, fiber: 5.2, fat: 3.5, manganese: 1.17, magnesium: 118, phosphorus: 281, folate: 78 },
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
    serving: '1 cup cooked (185g)'
  },
  {
    id: 'ginger', name: 'Ginger', emoji: '🫚', color: '#c8a96e', calories: 5,
    nutrition: { protein: 0.1, carbs: 1.1, fiber: 0.1, fat: 0.05, magnesium: 3, vitaminB6: 0.02, potassium: 46, gingerol: 25 },
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
    serving: '1 tbsp grated (6g)'
  }
];

app.get('/api/foods', (req, res) => res.json(foods));
app.get('/api/foods/:id', (req, res) => {
  const food = foods.find(f => f.id === req.params.id);
  food ? res.json(food) : res.status(404).json({ error: 'Food not found' });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Healthy Food DB running at http://localhost:${PORT}`));
