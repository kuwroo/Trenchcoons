extends CharacterBody3D

var speed = 0.0
var max_speed = 20.0
var acceleration = 30.0
var friction = 10.0
var turn_speed = 2.5

func _physics_process(delta):

	# PLAYER 2 — movement
	if Input.is_action_pressed("accelerate"):
		speed += acceleration * delta
	elif Input.is_action_pressed("brake"):
		speed -= acceleration * delta
	else:
		speed = move_toward(speed, 0, friction * delta)

	speed = clamp(speed, -max_speed, max_speed)

	# PLAYER 1 — steering
	var turn = 0.0
	if Input.is_action_pressed("steer_left"):
		turn += 1
	if Input.is_action_pressed("steer_right"):
		turn -= 1

	# harder to control at high speed = FUN
	rotation.y += turn * turn_speed * delta * (speed / max_speed)

	# move forward
	velocity = -transform.basis.z * speed
	move_and_slide()
