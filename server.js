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
  }
];

app.get('/api/foods', (req, res) => res.json(foods));
app.get('/api/foods/:id', (req, res) => {
  const food = foods.find(f => f.id === req.params.id);
  food ? res.json(food) : res.status(404).json({ error: 'Food not found' });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Healthy Food DB running at http://localhost:${PORT}`));
