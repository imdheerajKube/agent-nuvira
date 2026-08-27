# Refactoring Patterns

## Extract Function/Method

Extract a block of code into a named function.

**Before:**
```javascript
function processOrder(order) {
  // Validate
  if (!order.items || order.items.length === 0) {
    throw new Error('No items');
  }
  if (order.total < 0) {
    throw new Error('Invalid total');
  }
  
  // Calculate discount
  let discount = 0;
  if (order.customer.type === 'vip') {
    discount = order.total * 0.1;
  } else if (order.customer.orders > 10) {
    discount = order.total * 0.05;
  }
  
  // Apply discount
  order.total -= discount;
  order.discount = discount;
}
```

**After:**
```javascript
function validateOrder(order) {
  if (!order.items || order.items.length === 0) {
    throw new Error('No items');
  }
  if (order.total < 0) {
    throw new Error('Invalid total');
  }
}

function calculateDiscount(order) {
  if (order.customer.type === 'vip') {
    return order.total * 0.1;
  } else if (order.customer.orders > 10) {
    return order.total * 0.05;
  }
  return 0;
}

function processOrder(order) {
  validateOrder(order);
  const discount = calculateDiscount(order);
  order.total -= discount;
  order.discount = discount;
}
```

## Replace Conditional with Polymorphism

Replace complex conditionals with object-oriented patterns.

**Before:**
```javascript
function getShippingCost(order) {
  if (order.type === 'standard') {
    return order.weight * 0.5;
  } else if (order.type === 'express') {
    return order.weight * 1.5;
  } else if (order.type === 'overnight') {
    return order.weight * 3.0;
  }
}
```

**After:**
```javascript
class ShippingStrategy {
  calculate(weight) { throw new Error('Not implemented'); }
}

class StandardShipping extends ShippingStrategy {
  calculate(weight) { return weight * 0.5; }
}

class ExpressShipping extends ShippingStrategy {
  calculate(weight) { return weight * 1.5; }
}

class OvernightShipping extends ShippingStrategy {
  calculate(weight) { return weight * 3.0; }
}

const strategies = {
  standard: new StandardShipping(),
  express: new ExpressShipping(),
  overnight: new OvernightShipping(),
};

function getShippingCost(order) {
  return strategies[order.type].calculate(order.weight);
}
```

## Introduce Parameter Object

Replace long parameter lists with an object.

**Before:**
```javascript
function createUser(name, email, phone, address, city, state, zip, country) {
  // ...
}
```

**After:**
```javascript
function createUser(userData) {
  const { name, email, phone, address, city, state, zip, country } = userData;
  // ...
}

// Or with TypeScript interface
interface UserAddress {
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

interface UserData {
  name: string;
  email: string;
  phone: string;
  address: UserAddress;
}

function createUser(userData: UserData) {
  // ...
}
```

## Replace Magic Numbers with Named Constants

**Before:**
```javascript
if (user.age > 65) {
  // ...
}
const tax = price * 0.08;
```

**After:**
```javascript
const SENIOR_AGE_THRESHOLD = 65;
const TAX_RATE = 0.08;

if (user.age > SENIOR_AGE_THRESHOLD) {
  // ...
}
const tax = price * TAX_RATE;
```

## Decompose Conditional

Extract complex conditionals into readable functions.

**Before:**
```javascript
if (date.isBefore(summerStart) || date.isAfter(summerEnd)) {
  charge = quantity * winterRate + winterServiceCharge;
} else {
  charge = quantity * summerRate;
}
```

**After:**
```javascript
function isWinter(date) {
  return date.isBefore(summerStart) || date.isAfter(summerEnd);
}

if (isWinter(date)) {
  charge = calculateWinterCharge(quantity);
} else {
  charge = calculateSummerCharge(quantity);
}
```

## Code Smells to Watch For

1. **Long Methods** (>30 lines) → Extract Function
2. **Duplicated Code** → Extract Function or Pull Up Method
3. **Long Parameter Lists** (>3 params) → Introduce Parameter Object
4. **Divergent Change** → Split Module
5. **Shotgun Surgery** → Move Method/FIELD
6. **Feature Envy** → Move Method
7. **Data Clumps** → Extract Class
8. **Primitive Obsession** → Replace Value with Object
9. **Switch Statements** → Replace Conditional with Polymorphism
10. **Parallel Inheritance** → Pull Up Method
