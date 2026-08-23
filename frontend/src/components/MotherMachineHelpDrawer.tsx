import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Box,
  Drawer,
  Grid,
  Icon,
  IconButton,
  Portal,
  Stack,
  Text,
} from '@chakra-ui/react'
import { CircleHelp, X } from 'lucide-react'

type MotherMachineHelpPage = 'nd2-files' | 'cell-extraction' | 'databases'

type HelpSectionProps = {
  number: string
  title: string
  children: ReactNode
}

const HelpSection = ({ number, title, children }: HelpSectionProps) => (
  <Box as="section">
    <Grid templateColumns="1.75rem minmax(0, 1fr)" gap="3" alignItems="start">
      <Box
        display="flex"
        alignItems="center"
        justifyContent="center"
        w="1.75rem"
        h="1.75rem"
        borderRadius="full"
        bg="tide.500"
        color="white"
        fontSize="xs"
        fontWeight="700"
      >
        {number}
      </Box>
      <Box minW="0">
        <Text fontSize="sm" fontWeight="700" color="ink.900" mb="1.5">
          {title}
        </Text>
        <Stack spacing="2" fontSize="sm" color="ink.700" lineHeight="1.8">
          {children}
        </Stack>
      </Box>
    </Grid>
  </Box>
)

const Nd2FilesHelp = () => (
  <>
    <HelpSection number="1" title="ND2ファイルを追加する">
      <Text><Text as="span" fontWeight="700" color="ink.900">Upload ND2</Text>からMother Machine用のND2ファイルを選択します。アップロード後は一覧へ追加されます。</Text>
    </HelpSection>
    <HelpSection number="2" title="細胞を抽出・確認する">
      <Text>未抽出のファイルは<Text as="span" fontWeight="700" color="ink.900">Extract cells</Text>、抽出済みのファイルは<Text as="span" fontWeight="700" color="ink.900">Review cells</Text>から抽出レビュー画面を開きます。</Text>
      <Text><Text as="span" fontWeight="700" color="ink.900">Re-extract</Text>を実行すると、既存の抽出データベースを新しい結果で置き換えます。</Text>
    </HelpSection>
    <HelpSection number="3" title="ファイルを管理する">
      <Text>MetadataでND2情報を確認し、Downloadで元ファイルを保存できます。削除すると、対応するMother Machine抽出データも削除されます。</Text>
    </HelpSection>
  </>
)

const CellExtractionHelp = () => (
  <>
    <HelpSection number="1" title="抽出条件を設定する">
      <Text><Text as="span" fontWeight="700" color="ink.900">Iteration number</Text>を指定してExtractを実行します。再抽出時は既存結果が置き換えられます。</Text>
    </HelpSection>
    <HelpSection number="2" title="FieldとROIを選ぶ">
      <Text>上部の番号でField of viewを切り替え、左側のROIボタンから観察するMother Machine channelを選びます。</Text>
    </HelpSection>
    <HelpSection number="3" title="フレームを確認する">
      <Text>Raw／Overlayを切り替え、スライダーまたはPlayでタイムフレームを移動します。左側にROI画像、右側に同じフレームの輪郭scatterが表示されます。</Text>
      <Text><Text as="span" fontWeight="700" color="ink.900">Aligned</Text>では、ドリフト補正済みのROIをタイムフレーム順に横へ連結した1枚の画像を表示・保存できます。Raw／Overlayの選択はAligned画像にも反映されます。</Text>
    </HelpSection>
    <HelpSection number="4" title="GIFを書き出す">
      <Text>各表示の下にある<Text as="span" fontWeight="700" color="ink.900">Export as GIF</Text>から、選択中のField・ROIについて全タイムフレームを順番に収録したGIFをダウンロードできます。</Text>
    </HelpSection>
  </>
)

const DatabasesHelp = () => (
  <>
    <HelpSection number="1" title="データベースを探す">
      <Text>検索欄へデータベース名または元ND2ファイル名を入力すると、一覧を絞り込めます。</Text>
    </HelpSection>
    <HelpSection number="2" title="抽出結果を確認する">
      <Text><Text as="span" fontWeight="700" color="ink.900">Review</Text>から、そのデータベースに対応するField・ROI・タイムフレームのレビュー画面を開きます。</Text>
    </HelpSection>
    <HelpSection number="3" title="保存・削除する">
      <Text>Downloadで自己完結型SQLiteデータベースを保存できます。削除ボタンはデータベースを削除するため、確認後に実行してください。</Text>
    </HelpSection>
  </>
)

const pageContent = {
  'nd2-files': {
    title: 'Mother Machine ND2 Files の使い方',
    description: 'Mother Machine用ND2ファイルの追加、抽出、管理を行う画面です。',
    body: <Nd2FilesHelp />,
  },
  'cell-extraction': {
    title: 'Mother Machine Cell Extraction の使い方',
    description: '抽出結果をField、ROI、タイムフレームごとに確認する画面です。',
    body: <CellExtractionHelp />,
  },
  databases: {
    title: 'Mother Machine Databases の使い方',
    description: '抽出済みデータベースの検索、閲覧、保存、削除を行う画面です。',
    body: <DatabasesHelp />,
  },
} satisfies Record<MotherMachineHelpPage, { title: string; description: string; body: ReactNode }>

export default function MotherMachineHelpDrawer({ page }: { page: MotherMachineHelpPage }) {
  const [open, setOpen] = useState(false)
  const content = pageContent[page]

  return (
    <Drawer.Root open={open} onOpenChange={(details) => setOpen(details.open)} placement="end" size="sm">
      <Drawer.Trigger asChild>
        <IconButton
          aria-label={`${content.title}を開く`}
          title="使い方"
          size={{ base: 'xs', md: 'sm' }}
          h={{ base: '1.75rem', md: '2rem' }}
          minW={{ base: '1.75rem', md: '2rem' }}
          border="1px solid"
          borderColor="sand.200"
          bg="sand.100"
          color="ink.700"
          _hover={{ bg: 'sand.200', color: 'ink.900' }}
          flexShrink={0}
        >
          <Icon as={CircleHelp} boxSize={{ base: 3, md: 4 }} />
        </IconButton>
      </Drawer.Trigger>

      <Portal>
        <Drawer.Backdrop bg="rgba(11, 13, 16, 0.55)" />
        <Drawer.Positioner>
          <Drawer.Content
            bg="sand.50"
            color="ink.900"
            borderLeft="1px solid"
            borderColor="sand.200"
            maxW={{ base: 'calc(100vw - 1rem)', sm: '28rem' }}
          >
            <Drawer.Header px={{ base: 5, md: 6 }} py="5" borderBottom="1px solid" borderColor="sand.200" alignItems="flex-start">
              <Box pr="10">
                <Drawer.Title fontSize="lg" color="ink.900">{content.title}</Drawer.Title>
                <Drawer.Description mt="1" color="ink.700" lineHeight="1.7">{content.description}</Drawer.Description>
              </Box>
            </Drawer.Header>
            <Drawer.Body px={{ base: 5, md: 6 }} py="5" overflowY="auto" overscrollBehavior="contain">
              <Stack spacing="7" pb="6">{content.body}</Stack>
            </Drawer.Body>
            <Drawer.CloseTrigger asChild>
              <IconButton
                aria-label="使い方を閉じる"
                title="閉じる"
                size="sm"
                variant="ghost"
                color="ink.700"
                top="3.5"
                insetEnd="3.5"
                _hover={{ bg: 'sand.200', color: 'ink.900' }}
              >
                <X size={18} />
              </IconButton>
            </Drawer.CloseTrigger>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  )
}
