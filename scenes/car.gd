extends CharacterBody3D

@onready var cam = $Camera3D
@onready var engine_sound = $EngineSound

var speed = 0.0
var max_speed = 35.0        # 🔥 faster top speed
var acceleration = 60.0     # 🔥 quicker acceleration
var friction = 8.0
var turn_speed = 4.5        # 🔥 more sensitive steering

func _physics_process(delta):

	# 🚗 Movement (Player 2)
	if Input.is_action_pressed("accelerate"):
		speed += acceleration * delta
		
		if not engine_sound.playing:
			engine_sound.play()

	elif Input.is_action_pressed("brake"):
		speed -= acceleration * delta

		if engine_sound.playing:
			engine_sound.stop()

	else:
		speed = move_toward(speed, 0, friction * delta)

		if engine_sound.playing:
			engine_sound.stop()

	speed = clamp(speed, -max_speed, max_speed)

	# 🎮 Steering (Player 1)
	var turn = 0.0
	if Input.is_action_pressed("steer_left"):
		turn += 1
	if Input.is_action_pressed("steer_right"):
		turn -= 1

	# 😈 harder to control at higher speed
	rotation.y += turn * turn_speed * delta * (speed / max_speed) * 2.0

	# 🚗 Movement forward
	velocity = transform.basis.z * speed
	move_and_slide()

	# 🎥 Camera follow
	var offset = -transform.basis.z * 10 + Vector3(0, 6, 0)
	var target_pos = global_transform.origin + offset
	cam.global_transform.origin = cam.global_transform.origin.lerp(target_pos, 0.1)
	cam.look_at(global_transform.origin)

	# 🔊 Engine pitch changes with speed (VERY NICE EFFECT)
	engine_sound.pitch_scale = 0.8 + (abs(speed) / max_speed)

	# 🔄 Respawn if fall
	if global_position.y < 0:
		global_position = Vector3(0, 3, -60)
		speed = 0
