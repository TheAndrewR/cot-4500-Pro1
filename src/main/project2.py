def f(x):
    return pow(x, 3) + 4 * pow(x, 2) - 10
    
def fp(x):
    return 3 * pow(x, 2) + 8 * x
    
def g(x):
    return pow(3, -x)

# bisection method

tol = 0.0001
left = -4.0
right = 7.0

max = 1000

i = 0
p = 0.0

while (abs(right - left) > tol and i < max):
    i = i + 1
    p = (left + right) / 2
    
    if (f(left) < 0 and f(p) > 0):
        right = p
    else:
        left = p

#print(p)
print(i)

print()

# Newton Raphson Method

p = 0.0001
pn = -1
tol = 0.0001
max = 1000
i = 1
while (i <= max):
    if (fp(p) != 0):
        pn = p - f(p) / fp(p)
        
        if (abs(pn - p) < tol):
            print(i)
            break
            
        i = i + 1
        p = pn
    else:
        print("unsuccessful")
        
# Aproxximation Method

error_tolerance = 0.000001

guess = 1.0
i = 0

while True:
    next_guess = 0.5 * (guess + 3 / guess)
    
    print(f"Iteration {i + 1}: {next_guess}")

    if abs(next_guess - guess) < error_tolerance:
        break

    guess = next_guess
    i += 1

print(f"\nApproximated square root of 3: {next_guess}")
print(f"Number of iterations: {i + 1}")

#Fixed Point Iteration Method

p0 = 1
tol = .000001
N = 100

i = 1
while(i<=N):
    p = g(p0)
    if( abs(p - p0) < tol):
        print(p, "Success")
        break
    i = i + 1
    p0 = p
