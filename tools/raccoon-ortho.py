import bpy, os, math, mathutils

# THE OBJ MUST BE NEWER THAN THE SOURCE, and this guard is here because a stale
# one cost a full round. `raccoon-export.mjs` takes an output path argument; it
# was called with one that was NOT the path this script reads, so Blender happily
# re-imported, re-rendered and re-measured the PREVIOUS body — and every number
# was self-consistent, because the silhouette's BOUNDING BOX is set by the head
# and did not move when the body changed. The render looked plausible and was
# four hours out of date. Fail loudly instead.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OBJ = '/tmp/raccoon.obj'
SRC = os.path.join(ROOT, 'src/vehicle/raccoon.ts')
if not os.path.exists(OBJ):
    raise RuntimeError('STALE: %s does not exist -- run `node tools/raccoon-export.mjs`' % OBJ)
if os.path.getmtime(OBJ) < os.path.getmtime(SRC):
    raise RuntimeError('STALE: %s is older than raccoon.ts -- run `node tools/raccoon-export.mjs`'
                     ' (with NO path argument, so it writes where this script reads)' % OBJ)


for o in list(bpy.data.objects): bpy.data.objects.remove(o, do_unlink=True)
for m in list(bpy.data.meshes): bpy.data.meshes.remove(m)

# ── parse the OBJ, one object per group ─────────────────────────────────────
verts, groups, cur, mtl_of, last = [], [], None, {}, None
for line in open('/tmp/raccoon.mtl'):
    p = line.split()
    if p and p[0] == 'newmtl': last = p[1]
    if p and p[0] == 'Kd': mtl_of[last] = tuple(float(x) for x in p[1:4])
for line in open(OBJ):
    p = line.split()
    if not p: continue
    if p[0] == 'v': verts.append(tuple(float(x) for x in p[1:4]))
    elif p[0] == 'g': cur = [p[1], None, []]; groups.append(cur)
    elif p[0] == 'usemtl' and cur: cur[1] = p[1]
    elif p[0] == 'f' and cur: cur[2].append(tuple(int(t.split('/')[0]) - 1 for t in p[1:4]))

# Orthographic front/side/rear renders of the raccoon, for silhouette work.
#
#   npm run raccoon:ortho          (exports the OBJ, then renders)
#
# RUN IT HEADLESS. This used to be driven through the blender-mcp addon socket
# into a running GUI Blender, and that apparatus failed twice: once because the
# addon runs on `bpy.app.timers` and has no window context, so every `bpy.ops.*`
# that polls fails; and once because a guard raised `SystemExit`, which took the
# whole application down with it and needed a relaunch and a manual click in the
# N-panel to restore. `blender --background --python` has neither problem, needs
# nothing running, and is what the npm script uses.
#
# THE TAIL AND LIMBS ARE EXCLUDED. `raccoon-profile.mjs` normalises each row
# against the image's WIDEST row, and in the rest pose the tail splays further
# out than any part of the animal — so every body row was being divided by the
# tail's width and the body appeared to sit at 0.79 of maximum when the geometry
# says 0.94. Three edits were made on the strength of that before it was caught.
# The sheet's own front view has the tail hidden behind the body.
SKIP = ('tail', 'paw', 'upperArm', 'foreArm')

mats = {}
for name, col in mtl_of.items():
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    if b:
        b.inputs['Base Color'].default_value = (*col, 1)
        b.inputs['Roughness'].default_value = 0.95
        if 'Specular IOR Level' in b.inputs: b.inputs['Specular IOR Level'].default_value = 0.0
    mats[name] = m

lo = mathutils.Vector((1e9,) * 3); hi = mathutils.Vector((-1e9,) * 3)
for gname, gmtl, faces in groups:
    if gname.startswith(SKIP): continue
    used = sorted({i for f in faces for i in f})
    remap = {g: l for l, g in enumerate(used)}
    me = bpy.data.meshes.new(gname)
    me.from_pydata([verts[i] for i in used], [], [tuple(remap[i] for i in f) for f in faces])
    me.update()
    if gmtl in mats: me.materials.append(mats[gmtl])
    ob = bpy.data.objects.new(gname, me)
    ob.rotation_euler = (math.pi / 2, 0, 0)   # game is Y-up, Blender is Z-up
    bpy.context.scene.collection.objects.link(ob)
    for i in used:
        x, y, z = verts[i]
        v = mathutils.Vector((x, -z, y))
        lo = mathutils.Vector(map(min, lo, v)); hi = mathutils.Vector(map(max, hi, v))

ctr = (lo + hi) / 2
size = max(hi - lo)
print('PROFILE BOUNDS lo=%s hi=%s size=%.3f' %
      (tuple(round(v, 3) for v in lo), tuple(round(v, 3) for v in hi), size))

w = bpy.data.worlds.new('W'); bpy.context.scene.world = w
w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.04, 0.05, 0.07, 1)
w.node_tree.nodes['Background'].inputs[1].default_value = 1.0
sun = bpy.data.objects.new('Sun', bpy.data.lights.new('S', 'SUN'))
bpy.context.scene.collection.objects.link(sun)
sun.data.energy = 2.4
# A fill from the opposite side. With a single key the profile views render as
# pure silhouette, which is useless for judging surface transitions — the whole
# reason for looking at the model in isolation.
fill = bpy.data.objects.new('Fill', bpy.data.lights.new('F', 'SUN'))
bpy.context.scene.collection.objects.link(fill)
fill.data.energy = 1.1
fill.rotation_euler = (math.radians(62), 0, math.radians(40))
sun.rotation_euler = (math.radians(52), 0, math.radians(205))

cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('C'))
bpy.context.scene.collection.objects.link(cam)
bpy.context.scene.camera = cam
# ORTHOGRAPHIC. A perspective render tapers with depth, so its silhouette is not
# the object's profile and cannot be compared with a flat drawing.
cam.data.type = 'ORTHO'
cam.data.ortho_scale = size * 1.12

sc = bpy.context.scene
sc.render.resolution_x = 700
sc.render.resolution_y = 900
sc.view_settings.view_transform = 'Standard'
try: sc.render.engine = 'BLENDER_EEVEE_NEXT'
except Exception: pass

# FRONT IS YAW 180, NOT 0. The game's forward is -Z (raccoon.ts: "+Y up, -Z
# forward"), and the Y-up -> Z-up rotation maps that to Blender's +Y — so a
# camera at yaw 0, which sits at -Y looking toward +Y, is standing BEHIND the
# animal. Every view labelled "front" was the rear, and the whole front-silhouette
# fit was run against the rear silhouette. A near-symmetric animal made that
# survivable and invisible: the ruff and the egg look much the same from either
# side, and only the muzzle gave it away.
for name, yaw in [('front', 180), ('side', 90), ('rear', 0)]:
    a = math.radians(yaw)
    d = size * 3
    cam.location = (ctr.x + math.sin(a) * d, ctr.y - math.cos(a) * d, ctr.z)
    v = ctr - cam.location
    cam.rotation_euler = (math.pi / 2 - math.atan2(v.z, math.hypot(v.x, v.y)), 0,
                          math.atan2(v.y, v.x) - math.pi / 2)
    sc.render.filepath = f'/tmp/ortho_build_{name}.png'
    bpy.ops.render.render(write_still=True)
print('ORTHO SCALE %.3f  RENDERED' % cam.data.ortho_scale)
